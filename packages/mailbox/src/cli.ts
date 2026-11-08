#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { createAgentMailStore, type AgentMailPriority, type AgentMailStatus, type AgentMailType } from './index.js';
import { buildBranchReviewManifest } from './branch-review-manifest.js';
import { validateSingleRecipient } from './recipients.js';

interface ParsedArgs {
  command: string;
  options: Map<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command = '', ...rest] = argv;
  const options = new Map<string, string | boolean>();

  for (let i = 0; i < rest.length; i += 1) {
    const current = rest[i];
    if (!current?.startsWith('--')) continue;
    const key = current.slice(2);
    const next = rest[i + 1];
    if (!next || next.startsWith('--')) {
      options.set(key, true);
      continue;
    }
    options.set(key, next);
    i += 1;
  }

  return { command, options };
}

function getRequired(options: Map<string, string | boolean>, key: string): string {
  const value = options.get(key);
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Missing required --${key}`);
  }
  return value.trim();
}

function getOptional(options: Map<string, string | boolean>, key: string): string | undefined {
  const value = options.get(key);
  return typeof value === 'string' ? value.trim() : undefined;
}

function getBoolean(options: Map<string, string | boolean>, key: string): boolean {
  return options.get(key) === true;
}

/**
 * The agent-time deferral rule, enforced at the TRANSPORT rather than per runtime.
 *
 * Rule: ~/.claude/rules/agent-time-and-deferral.md. It used to run only as a Claude
 * PreToolUse Bash hook, so Codex turns and MCP tools bypassed it entirely -- the
 * structural gap in hercule's review (A.4: "transport cannot be fixed inside a Bash
 * hook"). Enforcing it here means it applies to every runtime that sends mail.
 *
 * The REGEXES ARE NOT DUPLICATED HERE. This shells out to the one implementation in
 * SHARED/hooks/deferral_check.py, which the Bash hook imports directly. A second
 * copy in TypeScript is how the two surfaces would drift.
 *
 * FAILS OPEN, deliberately (isla's decision): mail must not depend on the guard
 * being healthy, so a missing interpreter or a broken checker warns and permits.
 * But a fail-open is JOURNALLED with its own kind, because stderr alone is a log
 * nobody reads -- a broken checker has to show up as a run of fail-opens rather
 * than as a quiet, compliant fleet.
 */
const DEFERRAL_CHECKER =
  process.env.DEFERRAL_CHECK ?? '/Volumes/Repo-Drive/agents/SHARED/hooks/deferral_check.py';
const DEFERRAL_JOURNAL =
  process.env.DEFERRAL_GUARD_JOURNAL ?? '/Volumes/Repo-Drive/agents/SHARED/reports/deferral-guard.jsonl';

function journalDeferralEvent(kind: string, fields: Record<string, unknown>): void {
  // Written here rather than through the Python module for one reason: when the
  // interpreter is what failed, Python cannot be the thing that records it.
  try {
    fs.mkdirSync(path.dirname(DEFERRAL_JOURNAL), { recursive: true });
    fs.appendFileSync(
      DEFERRAL_JOURNAL,
      `${JSON.stringify({ ts: Date.now() / 1000, kind, source: 'agent-mail-cli', ...fields })}\n`,
    );
  } catch {
    /* logging must never break a send */
  }
}

function enforceAgentTimeRule(body: string, options: Map<string, string | boolean>): void {
  const waitsOn = getOptional(options, 'waits-on');
  if (waitsOn && waitsOn.length >= 7) return; // a named external blocker, kept in metadata

  const result = spawnSync(process.env.DEFERRAL_CHECK_PYTHON ?? '/usr/bin/python3',
    [DEFERRAL_CHECKER, '--stdin', '--source', 'agent-mail-cli'],
    { input: body, encoding: 'utf8' });

  if (result.error || result.status !== 0) {
    const reason = result.error ? String(result.error) : `checker exit ${result.status}`;
    journalDeferralEvent('fail-open', { reason });
    process.stderr.write(
      `agent-time rule NOT CHECKED (${reason}). Sending anyway; the event is in ` +
        `${DEFERRAL_JOURNAL}.\n`,
    );
    return;
  }

  let hits: Array<[string, string, string]> = [];
  try {
    hits = (JSON.parse(result.stdout).hits ?? []) as Array<[string, string, string]>;
  } catch (err) {
    journalDeferralEvent('fail-open', { reason: `unparseable checker output: ${String(err)}` });
    process.stderr.write('agent-time rule NOT CHECKED (unparseable checker output).\n');
    return;
  }
  if (hits.length === 0) return;

  journalDeferralEvent('block', { hits });
  const lines = hits.slice(0, 5).map(([kind, word, snippet]) => `  - ${kind}: '${word}' in: ${snippet}`);
  throw new Error(
    'BLOCKED (agent-time rule, ~/.claude/rules/agent-time-and-deferral.md): this message ' +
      'defers work or estimates it in human time.\n' +
      `${lines.join('\n')}\n` +
      'Agents work around the clock. Rewrite with a minutes estimate and do the work now. ' +
      'If there is a REAL external blocker (a human\'s answer, a third party, a scheduled ' +
      'event, a usage cap, or named higher-priority work), pass it as metadata: ' +
      '--waits-on "<the blocker>".',
  );
}

function readBody(options: Map<string, string | boolean>): string {
  const body = getOptional(options, 'body');
  const bodyFile = getOptional(options, 'body-file');
  const resolved = bodyFile ? fs.readFileSync(bodyFile, 'utf8') : body;
  if (!resolved) throw new Error('Missing body content. Use --body or --body-file');
  // Enforced HERE because this is the single function both `send` and `reply` use
  // to obtain a body, so a future subcommand cannot acquire one unchecked.
  enforceAgentTimeRule(resolved, options);
  return resolved;
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

const USAGE = `agent-mail — durable local mailbox for agent-to-agent coordination

Usage: agent-mail <command> [options]

Commands:
  send    --from <agent> --to <agent> --type <type> --subject <s> (--body <md> | --body-file <path>)
          [--project <p>] [--priority low|normal|high] [--requires-response]
          [--waits-on "<external blocker>"]   (agent-time rule override, kept in metadata)
  inbox   --agent <agent> [--status new|acked|closed]   (closed excluded unless --status given)
  ack     --agent <agent> --id <messageId>
  reply   --agent <agent> --id <messageId> (--body <md> | --body-file <path>)
          [--subject <s>] [--priority low|normal|high] [--requires-response]
  close   --agent <agent> --id <messageId>
  thread  (--id <messageId> | --correlation-id <corrId>)
  branch-manifest --repo <path> [--base origin/main] [--branch HEAD]
          --test-command <command> [--output <path>]
  help    Show this help

Environment:
  AGENT_MAIL_DIR            Directory holding the shared agent_mail.db (required)
  AGENT_MAIL_ALLOW_DEFAULT  Set to 1 to opt into the default dir when AGENT_MAIL_DIR is unset

Types: question, decision_request, handoff, status, artifact, note, alert

Handoff bodies must include non-empty lines for: Owner, Next action, Artifact,
and Verification status.
`;

function isHelpRequest(argv: string[]): boolean {
  return argv.length === 0 || argv.some((arg) => arg === 'help' || arg === '--help' || arg === '-h');
}

function main(): void {
  const argv = process.argv.slice(2);

  // Detect help before opening the store: `--help`/`-h` land in the command
  // position, so the store must not be constructed (its AGENT_MAIL_DIR guard
  // would turn a plain help request into an env-var error).
  if (isHelpRequest(argv)) {
    process.stdout.write(USAGE);
    return;
  }

  const { command, options } = parseArgs(argv);
  if (command === 'branch-manifest') {
    const manifest = buildBranchReviewManifest({
      repoPath: getOptional(options, 'repo') ?? process.cwd(),
      baseRef: getOptional(options, 'base') ?? 'origin/main',
      branchRef: getOptional(options, 'branch') ?? 'HEAD',
      testCommand: getRequired(options, 'test-command'),
    });
    const output = getOptional(options, 'output');
    if (output) {
      fs.writeFileSync(output, manifest);
    } else {
      process.stdout.write(manifest);
    }
    return;
  }
  const store = createAgentMailStore();

  try {
    switch (command) {
      case 'send': {
        const message = store.send({
          fromAgent: getRequired(options, 'from'),
          toAgent: validateSingleRecipient(getRequired(options, 'to')),
          type: getRequired(options, 'type') as AgentMailType,
          subject: getRequired(options, 'subject'),
          bodyMd: readBody(options),
          relatedProject: getOptional(options, 'project'),
          requiresResponse: getBoolean(options, 'requires-response'),
          priority: (getOptional(options, 'priority') as AgentMailPriority | undefined) ?? 'normal',
          waitsOn: getOptional(options, 'waits-on'),
        });
        printJson(message);
        break;
      }
      case 'inbox': {
        const messages = store.listInbox({
          agent: getRequired(options, 'agent'),
          status: getOptional(options, 'status') as AgentMailStatus | undefined,
        });
        printJson(messages);
        break;
      }
      case 'ack': {
        const message = store.ackMessage(getRequired(options, 'agent'), getRequired(options, 'id'));
        printJson(message);
        break;
      }
      case 'reply': {
        const message = store.reply({
          actorAgent: getRequired(options, 'agent'),
          messageId: getRequired(options, 'id'),
          bodyMd: readBody(options),
          subject: getOptional(options, 'subject'),
          requiresResponse: getBoolean(options, 'requires-response'),
          priority: getOptional(options, 'priority') as AgentMailPriority | undefined,
          waitsOn: getOptional(options, 'waits-on'),
        });
        printJson(message);
        break;
      }
      case 'close': {
        const message = store.closeMessage(getRequired(options, 'agent'), getRequired(options, 'id'));
        printJson(message);
        break;
      }
      case 'thread': {
        const messageId = getOptional(options, 'id');
        const correlationId = getOptional(options, 'correlation-id');
        if (!messageId && !correlationId) {
          throw new Error('Missing --id or --correlation-id');
        }
        const resolvedCorrelationId = correlationId ?? store.getMessage(messageId!)?.correlationId;
        if (!resolvedCorrelationId) throw new Error(`Message not found: ${messageId}`);
        printJson(store.getThread(resolvedCorrelationId));
        break;
      }
      default:
        throw new Error(`Unsupported command: ${command}`);
    }
  } finally {
    store.close();
  }
}

main();
