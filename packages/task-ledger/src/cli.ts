#!/usr/bin/env node
import {
  createTask,
  getTask,
  listTasks,
  updateTask,
  closeTask,
  type TaskStatus,
  type TaskPriority,
  type TaskPatch,
} from './index.js';

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

const USAGE = `task-ledger <command> [options]
  add    --owner X --title "..." [--created-by Y] [--priority low|med|high] [--context "..."] [--links a,b] [--tags x,y]
  update --id T [--status open|in_progress|blocked|handed_off|done|killed] [--priority ...] [--title ...] [--owner ...] [--context ...] [--blocked-on ...] [--handoff-to ...]
  list   [--owner X] [--status in_progress,blocked] [--json]
  show   --id T
  close  --id T [--outcome done|killed]`;

function main(): void {
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
    case 'list': {
      const tasks = listTasks({ owner: opts.owner, status: opts.status ? (csv(opts.status) as TaskStatus[]) : undefined });
      if (opts.json) {
        console.log(JSON.stringify(tasks, null, 2));
      } else if (tasks.length === 0) {
        console.log('(no tasks)');
      } else {
        for (const t of tasks) console.log(fmtLine(t));
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

main();
