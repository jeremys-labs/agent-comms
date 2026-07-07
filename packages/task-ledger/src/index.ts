import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

// Cross-agent task ledger: durable, file-based work-STATE shared across the
// fleet. Sibling to the mailbox (agent-mail = coordination messages; this =
// the work state those messages are about). One JSON file per task under
// <dir>/tasks/<id>.json, written atomically (tmp + rename). Per-task files
// mean parallel agents writing DIFFERENT tasks never contend; same-task
// updates are last-writer-wins, which is fine for P0.
//
// P1 NOTE (flagged, not built per Isla): the one real concurrency risk is two
// agents updating the SAME task's status at once (e.g. a shared item). If that
// shows up, add compare-and-swap on updatedAt (reject a write whose base
// updatedAt is stale) — do NOT add an index/cache/manager layer; list stays
// read-all-and-filter at fleet scale (dozens of tasks).

export const DEFAULT_TASK_LEDGER_DIR = '/Volumes/Repo-Drive/agents/SHARED/task-ledger';

export type TaskStatus = 'open' | 'in_progress' | 'blocked' | 'handed_off' | 'done' | 'killed';
export type TaskPriority = 'low' | 'med' | 'high';

export interface TaskRecord {
  id: string;
  title: string;
  owner: string;
  status: TaskStatus;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  blockedOn: string | null;
  handoffTo: string | null;
  context: string;
  links: string[];
  priority: TaskPriority;
  tags: string[];
}

export interface CreateTaskInput {
  title: string;
  owner: string;
  createdBy: string;
  priority?: TaskPriority;
  context?: string;
  links?: string[];
  tags?: string[];
}

/** Fields a caller may patch via updateTask. Identity/provenance stay fixed. */
export type TaskPatch = Partial<
  Pick<TaskRecord, 'title' | 'owner' | 'status' | 'priority' | 'context' | 'links' | 'tags' | 'blockedOn' | 'handoffTo'>
>;

export interface ListFilter {
  owner?: string;
  status?: TaskStatus[];
}

export function resolveTaskLedgerDir(): string {
  return process.env.TASK_LEDGER_DIR || DEFAULT_TASK_LEDGER_DIR;
}

function tasksDir(dir: string): string {
  return path.join(dir, 'tasks');
}

function taskPath(dir: string, id: string): string {
  return path.join(tasksDir(dir), `${id}.json`);
}

function nowIso(): string {
  return new Date().toISOString();
}

function genId(): string {
  return `T_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
}

function atomicWriteJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, filePath);
}

export function createTask(input: CreateTaskInput, dir = resolveTaskLedgerDir()): TaskRecord {
  const ts = nowIso();
  const task: TaskRecord = {
    id: genId(),
    title: input.title,
    owner: input.owner,
    status: 'open',
    createdBy: input.createdBy,
    createdAt: ts,
    updatedAt: ts,
    blockedOn: null,
    handoffTo: null,
    context: input.context ?? '',
    links: input.links ?? [],
    priority: input.priority ?? 'med',
    tags: input.tags ?? [],
  };
  atomicWriteJson(taskPath(dir, task.id), task);
  return task;
}

export function getTask(id: string, dir = resolveTaskLedgerDir()): TaskRecord | null {
  try {
    return JSON.parse(fs.readFileSync(taskPath(dir, id), 'utf8')) as TaskRecord;
  } catch {
    return null;
  }
}

export function listTasks(filter: ListFilter = {}, dir = resolveTaskLedgerDir()): TaskRecord[] {
  let files: string[];
  try {
    files = fs.readdirSync(tasksDir(dir));
  } catch {
    return [];
  }
  const tasks: TaskRecord[] = [];
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    try {
      tasks.push(JSON.parse(fs.readFileSync(path.join(tasksDir(dir), file), 'utf8')) as TaskRecord);
    } catch {
      // skip a partial/corrupt file rather than failing the whole list
    }
  }
  const statusSet = filter.status ? new Set(filter.status) : null;
  return tasks
    .filter((t) => (filter.owner ? t.owner === filter.owner : true))
    .filter((t) => (statusSet ? statusSet.has(t.status) : true))
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
}

/** Thrown when a compare-and-set updateTask sees the on-disk record has moved
 * on from the base version the caller read — i.e. a concurrent same-task write
 * would silently clobber it. */
export class StaleTaskWriteError extends Error {
  constructor(id: string, expected: string, actual: string) {
    super(`Stale update for task ${id}: expected updatedAt ${expected}, found ${actual}`);
    this.name = 'StaleTaskWriteError';
  }
}

/**
 * Patch a task. When `expectedUpdatedAt` is supplied, the write is compare-and-
 * set: it is rejected (StaleTaskWriteError) if the stored `updatedAt` no longer
 * matches, so two agents transitioning the SAME task can't silently overwrite
 * each other (the P1 concurrency risk the header comment warns about). Omitting
 * it keeps the original last-writer-wins behaviour for single-writer callers.
 */
export function updateTask(
  id: string,
  patch: TaskPatch,
  dir = resolveTaskLedgerDir(),
  expectedUpdatedAt?: string,
): TaskRecord {
  const existing = getTask(id, dir);
  if (!existing) throw new Error(`Task not found: ${id}`);
  if (expectedUpdatedAt !== undefined && existing.updatedAt !== expectedUpdatedAt) {
    throw new StaleTaskWriteError(id, expectedUpdatedAt, existing.updatedAt);
  }
  // updatedAt doubles as the compare-and-set token, so it must strictly advance
  // even for two writes that land within the same millisecond.
  let updatedAt = nowIso();
  if (updatedAt <= existing.updatedAt) {
    updatedAt = new Date(new Date(existing.updatedAt).getTime() + 1).toISOString();
  }
  const updated: TaskRecord = { ...existing, ...patch, updatedAt };
  atomicWriteJson(taskPath(dir, id), updated);
  return updated;
}

export function closeTask(id: string, outcome: 'done' | 'killed', dir = resolveTaskLedgerDir()): TaskRecord {
  return updateTask(id, { status: outcome }, dir);
}

/** P1: hand a task to another agent. State only — the CLI emits the agent-mail
 * notification (buildHandoffNotification) so the store stays mailbox-free. */
export function handoffTask(id: string, toAgent: string, dir = resolveTaskLedgerDir()): TaskRecord {
  return updateTask(id, { status: 'handed_off', handoffTo: toAgent }, dir);
}

/** P1: mark a task blocked with a reason or blocking task id. */
export function blockTask(id: string, blockedOn: string, dir = resolveTaskLedgerDir()): TaskRecord {
  return updateTask(id, { status: 'blocked', blockedOn }, dir);
}
