#!/usr/bin/env node
import fs from 'node:fs';
import process from 'node:process';
import { fetchAgentCard, getTask } from './client.js';
import { resolveA2APaths } from './paths.js';
import { getPeerOrThrow, loadPeerRegistry } from './registry.js';
import { sendAndTrack } from './send-and-track.js';
import type { A2AProjectScope } from './types.js';

interface ParsedArgs {
  command: string;
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command = '', ...rest] = argv;
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = rest[i + 1];
    if (!next || next.startsWith('--')) {
      flags[key] = true;
    } else {
      flags[key] = next;
      i += 1;
    }
  }
  return { command, flags };
}

function requireFlag(flags: Record<string, string | boolean>, key: string): string {
  const value = flags[key];
  if (typeof value !== 'string' || !value) {
    throw new Error(`Missing required --${key}`);
  }
  return value;
}

function optionalFlag(flags: Record<string, string | boolean>, key: string): string | undefined {
  const value = flags[key];
  return typeof value === 'string' ? value : undefined;
}

function readBody(flags: Record<string, string | boolean>): string {
  const inline = optionalFlag(flags, 'text');
  if (inline) return inline;
  const file = optionalFlag(flags, 'text-file') ?? optionalFlag(flags, 'body-file');
  if (file) return fs.readFileSync(file, 'utf8');
  throw new Error('Missing message body: pass --text "..." or --text-file <path>');
}

function resolveProject(flags: Record<string, string | boolean>): A2AProjectScope {
  const raw = optionalFlag(flags, 'project') ?? 'private';
  if (raw === 'private' || raw === 'frontdesk' || raw === 'inference') return raw;
  throw new Error(`Invalid --project ${raw}. Must be private | frontdesk | inference.`);
}

async function main(): Promise<void> {
  const { command, flags } = parseArgs(process.argv.slice(2));
  const paths = resolveA2APaths();

  switch (command) {
    case 'send': {
      const peer = getPeerOrThrow(requireFlag(flags, 'peer'), paths);
      const result = await sendAndTrack({
        peer,
        fromAgent: requireFlag(flags, 'from'),
        skillId: requireFlag(flags, 'skill'),
        text: readBody(flags),
        project: resolveProject(flags),
        callbackSubject: optionalFlag(flags, 'subject'),
        correlationId: optionalFlag(flags, 'correlation-id'),
        paths,
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }
    case 'status': {
      const peer = getPeerOrThrow(requireFlag(flags, 'peer'), paths);
      const task = await getTask({ peer, taskId: requireFlag(flags, 'task') });
      process.stdout.write(`${JSON.stringify(task, null, 2)}\n`);
      return;
    }
    case 'peers':
    case 'list-peers': {
      const reg = loadPeerRegistry(paths);
      process.stdout.write(`${JSON.stringify(reg, null, 2)}\n`);
      return;
    }
    case 'card': {
      const peer = getPeerOrThrow(requireFlag(flags, 'peer'), paths);
      const card = await fetchAgentCard(peer);
      process.stdout.write(`${JSON.stringify(card, null, 2)}\n`);
      return;
    }
    case '':
    case 'help':
    case '--help':
    case '-h': {
      printHelp();
      return;
    }
    default:
      throw new Error(`Unsupported command: ${command}`);
  }
}

function printHelp(): void {
  process.stdout.write(`a2a-mail — outbound A2A client

Usage:
  a2a-mail send    --peer <key> --from <agent> --skill <id> --text "..." [--project private|frontdesk|inference] [--subject "..."] [--correlation-id <id>]
  a2a-mail status  --peer <key> --task <task-id>
  a2a-mail card    --peer <key>
  a2a-mail peers
  a2a-mail help

\`send\` writes a pending row under ~/.tmux-mcc/a2a/pending.jsonl that the mcc-tmux
runtime-a2a-poller drains, returning the result into the originating agent's
mailbox. \`--project\` defaults to private; only frontdesk/inference scopes
log payload contents in the audit file.
`);
}

main().catch((error) => {
  process.stderr.write(`a2a-mail: ${(error as Error).message}\n`);
  process.exit(1);
});
