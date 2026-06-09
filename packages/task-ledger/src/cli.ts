#!/usr/bin/env node
import {
  createTask,
  getTask,
  listTasks,
  updateTask,
  closeTask,
  handoffTask,
  blockTask,
  type TaskStatus,
  type TaskPriority,
  type TaskPatch,
  type TaskRecord,
} from './index.js';
import { buildHandoffNotification } from './notify.js';

// Thin CLI over the tested store — parse, dispatch, print. No logic here.
// Mirrors agent-mail ergonomics so the team already knows the shape.

function parseArgs(argv: string[]): { cmd: string; opts: Record<string, string> } {
  const cmd = argv[0] ?? '';
  const opts: Record<string, string> = {};
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        opts[key] = 'true';
      } else {
        opts[key] = next;
        i++;
      }
    }
  }
  return { cmd, opts };
}

function csv(v: string | undefined): string[] {
  return v ? v.split(',').map((s) => s.trim()).filter(Boolean) : [];
}

function fmtLine(t: { id: string; status: string; priority: string; owner: string; title: string }): string {
  return `${t.id}  [${t.status}/${t.priority}]  @${t.owner}  ${t.title}`;
}

function fail(msg: string): never {
  console.error(`task-ledger: ${msg}`);
  process.exit(1);
}

function fmtFleetLine(t: TaskRecord): string {
  const extra = t.status === 'blocked' && t.blockedOn ? `  blocked-on: ${t.blockedOn}`
    : t.status === 'handed_off' && t.handoffTo ? `  -> @${t.handoffTo}`
    : '';
  return `${t.id}  [${t.status}/${t.priority}]  @${t.owner}  ${t.title}${extra}`;
}

const USAGE = `task-ledger <command> [options]
  add     --owner X --title "..." [--created-by Y] [--priority low|med|high] [--context "..."] [--links a,b] [--tags x,y]
  update  --id T [--status open|in_progress|blocked|handed_off|done|killed] [--priority ...] [--title ...] [--owner ...] [--context ...] [--blocked-on ...] [--handoff-to ...]
  handoff --id T --to AGENT [--from AGENT]      (sets handed_off + sends an agent-mail handoff notification)
  block   --id T --blocked-on "..."
  list    [--owner X] [--status in_progress,blocked] [--fleet] [--json]
  show    --id T
  close   --id T [--outcome done|killed]`;

async function main(): Promise<void> {
  const { cmd, opts } = parseArgs(process.argv.slice(2));

  switch (cmd) {
    case 'add': {
      if (!opts.owner || !opts.title) fail('add requires --owner and --title');
      const t = createTask({
        title: opts.title,
        owner: opts.owner,
        createdBy: opts['created-by'] ?? opts.owner,
        priority: opts.priority as TaskPriority | undefined,
        context: opts.context,
        links: csv(opts.links),
        tags: csv(opts.tags),
      });
      console.log(JSON.stringify(t, null, 2));
      break;
    }
    case 'update': {
      if (!opts.id) fail('update requires --id');
      const patch: TaskPatch = {};
      if (opts.status) patch.status = opts.status as TaskStatus;
      if (opts.priority) patch.priority = opts.priority as TaskPriority;
      if (opts.title) patch.title = opts.title;
      if (opts.owner) patch.owner = opts.owner;
      if (opts.context !== undefined) patch.context = opts.context;
      if (opts['blocked-on'] !== undefined) patch.blockedOn = opts['blocked-on'];
      if (opts['handoff-to'] !== undefined) patch.handoffTo = opts['handoff-to'];
      if (opts.links !== undefined) patch.links = csv(opts.links);
      if (opts.tags !== undefined) patch.tags = csv(opts.tags);
      try {
        console.log(JSON.stringify(updateTask(opts.id, patch), null, 2));
      } catch (e) {
        fail(e instanceof Error ? e.message : String(e));
      }
      break;
    }
    case 'handoff': {
      if (!opts.id || !opts.to) fail('handoff requires --id and --to');
      const before = getTask(opts.id);
      if (!before) fail(`task not found: ${opts.id}`);
      const from = opts.from ?? before.owner;
      let task: TaskRecord;
      try {
        task = handoffTask(opts.id, opts.to);
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
      // Fail-soft notification: the handoff STATE is already committed; if the
      // mailbox can't be reached, warn but don't fail the handoff.
      try {
        const note = buildHandoffNotification(task, from);
        const { createAgentMailStore } = await import('@agent-comms/mailbox');
        createAgentMailStore().send({
          fromAgent: note.fromAgent,
          toAgent: note.toAgent,
          type: note.type,
          subject: note.subject,
          bodyMd: note.bodyMd,
          priority: note.priority,
          requiresResponse: note.requiresResponse,
          links: note.links,
        });
        console.error(`notified @${note.toAgent} via agent-mail`);
      } catch (e) {
        console.error(`warning: handoff saved but notification failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      console.log(JSON.stringify(task, null, 2));
      break;
    }
    case 'block': {
      if (!opts.id || !opts['blocked-on']) fail('block requires --id and --blocked-on');
      try {
        console.log(JSON.stringify(blockTask(opts.id, opts['blocked-on']), null, 2));
      } catch (e) {
        fail(e instanceof Error ? e.message : String(e));
      }
      break;
    }
    case 'list': {
      const fleet = Boolean(opts.fleet);
      // --fleet defaults to the live board (in_progress + blocked) across all owners.
      const status = opts.status ? (csv(opts.status) as TaskStatus[]) : fleet ? (['in_progress', 'blocked'] as TaskStatus[]) : undefined;
      const tasks = listTasks({ owner: fleet ? undefined : opts.owner, status });
      if (opts.json) {
        console.log(JSON.stringify(tasks, null, 2));
      } else if (tasks.length === 0) {
        console.log('(no tasks)');
      } else {
        for (const t of tasks) console.log(fleet ? fmtFleetLine(t) : fmtLine(t));
      }
      break;
    }
    case 'show': {
      if (!opts.id) fail('show requires --id');
      const t = getTask(opts.id);
      if (!t) fail(`task not found: ${opts.id}`);
      console.log(JSON.stringify(t, null, 2));
      break;
    }
    case 'close': {
      if (!opts.id) fail('close requires --id');
      const outcome = (opts.outcome ?? 'done') as 'done' | 'killed';
      if (outcome !== 'done' && outcome !== 'killed') fail('--outcome must be done or killed');
      try {
        console.log(JSON.stringify(closeTask(opts.id, outcome), null, 2));
      } catch (e) {
        fail(e instanceof Error ? e.message : String(e));
      }
      break;
    }
    case '':
    case 'help':
    case '--help':
      console.log(USAGE);
      break;
    default:
      fail(`unknown command "${cmd}"\n${USAGE}`);
  }
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
