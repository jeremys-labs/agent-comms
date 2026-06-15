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
  handoffTask,
  blockTask,
  isTaskStale,
  listStaleTasks,
  resolveTaskLedgerDir,
} from './index.js';
import { buildHandoffNotification } from './notify.js';

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

describe('stale task surfacing (P2)', () => {
  it('regression: surfaces active work after the real four-week silent-slip window', () => {
    const task = createTask(
      { title: 'Build OB1 outcome feedback loop', owner: 'eli', createdBy: 'eli' },
      dir,
    );
    const slipped: typeof task = {
      ...task,
      status: 'in_progress',
      updatedAt: '2026-05-12T12:00:00.000Z',
    };
    fs.writeFileSync(path.join(dir, 'tasks', `${task.id}.json`), JSON.stringify(slipped));

    const stale = listStaleTasks(
      { olderThanDays: 7, now: new Date('2026-06-09T12:00:00.000Z') },
      dir,
    );

    expect(stale.map((item) => item.id)).toEqual([task.id]);
  });

  it('does not flag recently updated or closed work', () => {
    const recent = createTask({ title: 'recent', owner: 'eli', createdBy: 'eli' }, dir);
    const done = closeTask(createTask({ title: 'done', owner: 'eli', createdBy: 'eli' }, dir).id, 'done', dir);
    const now = new Date(recent.updatedAt);
    now.setUTCDate(now.getUTCDate() + 30);

    expect(isTaskStale(recent, 31, now)).toBe(false);
    expect(isTaskStale(done, 0, now)).toBe(false);
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

describe('handoffTask (P1)', () => {
  it('sets status handed_off and records the new agent', () => {
    const t = createTask({ title: 'x', owner: 'eli', createdBy: 'eli' }, dir);
    const h = handoffTask(t.id, 'zara', dir);
    expect(h.status).toBe('handed_off');
    expect(h.handoffTo).toBe('zara');
    expect(getTask(t.id, dir)?.handoffTo).toBe('zara');
  });
});

describe('blockTask (P1)', () => {
  it('sets status blocked and records the blocker', () => {
    const t = createTask({ title: 'x', owner: 'eli', createdBy: 'eli' }, dir);
    const b = blockTask(t.id, 'waiting on Zara canary', dir);
    expect(b.status).toBe('blocked');
    expect(b.blockedOn).toBe('waiting on Zara canary');
  });
});

describe('buildHandoffNotification (P1)', () => {
  it('builds a handoff agent-mail addressed to the new owner, linking the task', () => {
    const t = createTask(
      { title: 'Run echo canary', owner: 'eli', createdBy: 'eli', priority: 'high', context: 'two-turn call', links: ['agent-mail:msg_1'] },
      dir,
    );
    const h = handoffTask(t.id, 'zara', dir);
    const note = buildHandoffNotification(h, 'eli');
    expect(note.fromAgent).toBe('eli');
    expect(note.toAgent).toBe('zara');
    expect(note.type).toBe('handoff');
    expect(note.subject).toContain('Run echo canary');
    expect(note.bodyMd).toContain(h.id);
    expect(note.bodyMd).toContain('two-turn call');
    expect(note.priority).toBe('high');
    // carries a ledger link to the task plus the task's own links
    const targets = note.links.map((l) => l.target);
    expect(targets).toContain(`task-ledger:${h.id}`);
    expect(targets).toContain('agent-mail:msg_1');
  });

  it('maps ledger priority med -> mail priority normal', () => {
    const t = createTask({ title: 'y', owner: 'eli', createdBy: 'eli' }, dir);
    const h = handoffTask(t.id, 'marcus', dir);
    expect(buildHandoffNotification(h, 'eli').priority).toBe('normal');
  });
});
