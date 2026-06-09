import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  createTask,
  getTask,
  listTasks,
  updateTask,
  closeTask,
  resolveTaskLedgerDir,
} from './index.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-ledger-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('resolveTaskLedgerDir', () => {
  it('honors TASK_LEDGER_DIR override', () => {
    process.env.TASK_LEDGER_DIR = dir;
    expect(resolveTaskLedgerDir()).toBe(dir);
    delete process.env.TASK_LEDGER_DIR;
  });
});

describe('createTask', () => {
  it('creates a retrievable task with sane defaults', () => {
    const t = createTask({ title: 'Wire OB1 into Pi', owner: 'eli', createdBy: 'eli' }, dir);
    expect(t.id).toMatch(/^T_/);
    expect(t.title).toBe('Wire OB1 into Pi');
    expect(t.owner).toBe('eli');
    expect(t.createdBy).toBe('eli');
    expect(t.status).toBe('open');
    expect(t.priority).toBe('med');
    expect(t.links).toEqual([]);
    expect(t.tags).toEqual([]);
    expect(t.blockedOn).toBeNull();
    expect(t.handoffTo).toBeNull();
    expect(t.createdAt).toBe(t.updatedAt);
    // round-trips from disk
    expect(getTask(t.id, dir)).toEqual(t);
  });

  it('preserves priority, context, links and tags', () => {
    const t = createTask(
      { title: 'x', owner: 'zara', createdBy: 'isla', priority: 'high', context: 'telnyx fire', links: ['agent-mail:msg_1', 'discord:42'], tags: ['frontdesk'] },
      dir,
    );
    expect(t.priority).toBe('high');
    expect(t.context).toBe('telnyx fire');
    expect(t.links).toEqual(['agent-mail:msg_1', 'discord:42']);
    expect(t.tags).toEqual(['frontdesk']);
  });

  it('gives distinct ids to two tasks and lists both', () => {
    const a = createTask({ title: 'a', owner: 'eli', createdBy: 'eli' }, dir);
    const b = createTask({ title: 'b', owner: 'eli', createdBy: 'eli' }, dir);
    expect(a.id).not.toBe(b.id);
    const ids = listTasks({}, dir).map((t) => t.id).sort();
    expect(ids).toEqual([a.id, b.id].sort());
  });
});

describe('getTask', () => {
  it('returns null for a missing id', () => {
    expect(getTask('T_nope', dir)).toBeNull();
  });
});

describe('updateTask', () => {
  it('changes status and bumps updatedAt while preserving other fields', () => {
    const t = createTask({ title: 'x', owner: 'eli', createdBy: 'eli' }, dir);
    const updated = updateTask(t.id, { status: 'in_progress' }, dir);
    expect(updated.status).toBe('in_progress');
    expect(updated.title).toBe('x');
    expect(updated.createdAt).toBe(t.createdAt);
    expect(updated.updatedAt >= t.updatedAt).toBe(true);
    expect(getTask(t.id, dir)?.status).toBe('in_progress');
  });

  it('throws for a missing id', () => {
    expect(() => updateTask('T_nope', { status: 'done' }, dir)).toThrow();
  });
});

describe('listTasks', () => {
  it('filters by owner and by status', () => {
    const e = createTask({ title: 'e', owner: 'eli', createdBy: 'eli' }, dir);
    const z = createTask({ title: 'z', owner: 'zara', createdBy: 'eli' }, dir);
    updateTask(z.id, { status: 'blocked' }, dir);
    expect(listTasks({ owner: 'eli' }, dir).map((t) => t.id)).toEqual([e.id]);
    expect(listTasks({ status: ['blocked'] }, dir).map((t) => t.id)).toEqual([z.id]);
  });
});

describe('closeTask', () => {
  it('closes as done or killed', () => {
    const a = createTask({ title: 'a', owner: 'eli', createdBy: 'eli' }, dir);
    const b = createTask({ title: 'b', owner: 'eli', createdBy: 'eli' }, dir);
    expect(closeTask(a.id, 'done', dir).status).toBe('done');
    expect(closeTask(b.id, 'killed', dir).status).toBe('killed');
  });
});
