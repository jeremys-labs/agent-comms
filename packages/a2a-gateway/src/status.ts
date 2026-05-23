#!/usr/bin/env node
import { A2ATaskStore, resolveA2AStateDir } from './store.js';
import type { A2ATaskRecord, A2ATaskState } from './types.js';

const VALID_STATES = new Set<A2ATaskState>(['submitted', 'working', 'completed', 'failed', 'canceled']);

interface StatusArgs {
  agent?: string;
  state?: A2ATaskState;
  limit: number;
  json: boolean;
}

function readFlag(args: string[], name: string): string | null {
  const index = args.indexOf(name);
  if (index === -1) return null;
  return args[index + 1] ?? null;
}

function parseArgs(argv: string[]): StatusArgs {
  const state = readFlag(argv, '--state');
  if (state && !VALID_STATES.has(state as A2ATaskState)) {
    throw new Error(`Invalid --state "${state}". Expected one of: ${[...VALID_STATES].join(', ')}`);
  }
  const limitRaw = readFlag(argv, '--limit');
  const limit = limitRaw ? Number.parseInt(limitRaw, 10) : 10;
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new Error('--limit must be a positive integer');
  }
  return {
    agent: readFlag(argv, '--agent') ?? undefined,
    state: state as A2ATaskState | undefined,
    limit,
    json: argv.includes('--json'),
  };
}

function summarize(records: A2ATaskRecord[]): Record<A2ATaskState, number> {
  const counts: Record<A2ATaskState, number> = {
    submitted: 0,
    working: 0,
    completed: 0,
    failed: 0,
    canceled: 0,
  };
  for (const record of records) counts[record.state] += 1;
  return counts;
}

function formatRecord(record: A2ATaskRecord): string {
  const preview = record.text.replace(/\s+/g, ' ').slice(0, 120);
  const response = record.responseText ? ` -> ${record.responseText.replace(/\s+/g, ' ').slice(0, 80)}` : '';
  return [
    `- ${record.id}`,
    `[${record.state}]`,
    `${record.remoteAgent} -> ${record.agentKey}`,
    `mail=${record.messageId}`,
    `updated=${record.updatedAt}`,
    `text="${preview}"${response}`,
  ].join(' ');
}

export function buildA2AStatusReport(args: StatusArgs, store = new A2ATaskStore()): Record<string, unknown> {
  const allRecords = store.listLatest({ limit: Number.MAX_SAFE_INTEGER });
  const records = store.listLatest({
    agentKey: args.agent,
    state: args.state,
    limit: args.limit,
  });
  return {
    stateDir: resolveA2AStateDir(),
    uniqueTaskCount: allRecords.length,
    counts: summarize(allRecords),
    filters: {
      agent: args.agent ?? null,
      state: args.state ?? null,
      limit: args.limit,
    },
    tasks: records,
  };
}

export function formatA2AStatusReport(report: Record<string, unknown>): string {
  const counts = report['counts'] as Record<string, number>;
  const filters = report['filters'] as Record<string, unknown>;
  const tasks = report['tasks'] as A2ATaskRecord[];
  return [
    'A2A Gateway Status',
    `state_dir: ${report['stateDir']}`,
    `unique_tasks: ${report['uniqueTaskCount']}`,
    `counts: submitted=${counts['submitted']} working=${counts['working']} completed=${counts['completed']} failed=${counts['failed']} canceled=${counts['canceled']}`,
    `filters: agent=${filters['agent'] ?? 'all'} state=${filters['state'] ?? 'all'} limit=${filters['limit']}`,
    '',
    tasks.length ? tasks.map(formatRecord).join('\n') : 'No A2A tasks found.',
  ].join('\n');
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const report = buildA2AStatusReport(args);
  process.stdout.write(args.json
    ? `${JSON.stringify(report, null, 2)}\n`
    : `${formatA2AStatusReport(report)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
