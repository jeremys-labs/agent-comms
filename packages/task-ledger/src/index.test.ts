import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  createTask,
  getTask,
  listTasks,
  updateTask,
  closeTask,
  handoffTask,
  blockTask,
  resolveTaskLedgerDir,
  StaleTaskWriteError,
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

  it('rejects a stale compare-and-set write and preserves the winner (M1)', () => {
    const t = createTask({ title: 'shared', owner: 'eli', createdBy: 'eli' }, dir);
    // Two agents both read the same base version of a shared task.
    const base = getTask(t.id, dir)!;
    // First writer commits against the shared base.
    const first = updateTask(t.id, { status: 'in_progress' }, dir, base.updatedAt);
    expect(first.status).toBe('in_progress');
    // Second writer used the same now-stale base — must be rejected, not clobber.
    expect(() => updateTask(t.id, { status: 'blocked' }, dir, base.updatedAt)).toThrow(StaleTaskWriteError);
    // On-disk state reflects the first writer only.
    expect(getTask(t.id, dir)?.status).toBe('in_progress');
  });

  it('keeps last-writer-wins when no expected updatedAt is supplied', () => {
    const t = createTask({ title: 'x', owner: 'eli', createdBy: 'eli' }, dir);
    expect(updateTask(t.id, { status: 'in_progress' }, dir).status).toBe('in_progress');
    expect(updateTask(t.id, { status: 'done' }, dir).status).toBe('done');
  });

  it('leaves no lock file behind after a successful update', () => {
    const t = createTask({ title: 'x', owner: 'eli', createdBy: 'eli' }, dir);
    updateTask(t.id, { status: 'in_progress' }, dir);
    const stray = fs.readdirSync(path.join(dir, 'tasks')).filter((f) => f.endsWith('.lock'));
    expect(stray).toEqual([]);
  });

  it('breaks a stale lock left by a crashed holder', () => {
    const t = createTask({ title: 'x', owner: 'eli', createdBy: 'eli' }, dir);
    const lockPath = path.join(dir, 'tasks', `${t.id}.json.lock`);
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999, ts: 0 }));
    // Backdate the lock well past the stale threshold (10s).
    const old = Date.now() / 1000 - 60;
    fs.utimesSync(lockPath, old, old);
    // Should break the stale lock and complete rather than hang.
    expect(updateTask(t.id, { status: 'in_progress' }, dir).status).toBe('in_progress');
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('serializes concurrent same-base updates across processes: exactly one wins (M1 lock)', async () => {
    const t = createTask({ title: 'shared', owner: 'eli', createdBy: 'eli' }, dir);
    const base = getTask(t.id, dir)!.updatedAt;

    const modulePath = fileURLToPath(new URL('./index.ts', import.meta.url));
    // repo root is four levels up from packages/task-ledger/src
    const tsxBin = path.resolve(path.dirname(modulePath), '../../../node_modules/.bin/tsx');
    const startFile = path.join(dir, 'go');
    const workerPath = path.join(dir, 'lock-worker.mjs');
    fs.writeFileSync(
      workerPath,
      [
        `import fs from 'node:fs';`,
        `const [modulePath, taskDir, id, base, startFile] = process.argv.slice(2);`,
        `const { updateTask, StaleTaskWriteError } = await import(modulePath);`,
        `while (!fs.existsSync(startFile)) {}`, // barrier: all workers contend at once
        `try { updateTask(id, { status: 'in_progress' }, taskDir, base); process.stdout.write('OK'); }`,
        `catch (e) { process.stdout.write(e instanceof StaleTaskWriteError ? 'STALE' : 'ERR:' + e.message); }`,
      ].join('\n'),
    );

    const N = 4;
    const runWorker = () =>
      new Promise<string>((resolve, reject) => {
        const child = spawn(tsxBin, [workerPath, modulePath, dir, t.id, base, startFile]);
        let out = '';
        child.stdout.on('data', (d) => (out += String(d)));
        child.stderr.on('data', (d) => (out += ''));
        child.on('error', reject);
        child.on('close', () => resolve(out));
      });

    const workers = Array.from({ length: N }, runWorker);
    // Give the children time to spawn and reach the barrier, then release them.
    await new Promise((r) => setTimeout(r, 1500));
    fs.writeFileSync(startFile, '1');
    const results = await Promise.all(workers);

    expect(results.filter((r) => r === 'OK')).toHaveLength(1);
    expect(results.filter((r) => r === 'STALE')).toHaveLength(N - 1);
    expect(getTask(t.id, dir)?.status).toBe('in_progress');
  }, 30_000);
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
