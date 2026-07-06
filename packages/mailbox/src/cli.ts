#!/usr/bin/env node
import fs from 'fs';
import { createAgentMailStore, type AgentMailMessage, type AgentMailPriority, type AgentMailStatus, type AgentMailType } from './index.js';
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

function getNonNegativeNumber(options: Map<string, string | boolean>, key: string, fallback: number): number {
  const value = getOptional(options, key);
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`--${key} must be a non-negative number`);
  }
  return parsed;
}

function getPositiveInteger(options: Map<string, string | boolean>, key: string, fallback: number): number {
  const value = getOptional(options, key);
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`--${key} must be a positive integer`);
  }
  return parsed;
}

function readBody(options: Map<string, string | boolean>): string {
  const body = getOptional(options, 'body');
  const bodyFile = getOptional(options, 'body-file');
  if (bodyFile) return fs.readFileSync(bodyFile, 'utf8');
  if (body) return body;
  throw new Error('Missing body content. Use --body or --body-file');
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function printMessageLines(messages: AgentMailMessage[]): void {
  for (const message of messages) {
    process.stdout.write(
      `${message.createdAt} ${message.id} ${message.fromAgent}->${message.toAgent} [${message.status}] ${message.subject}\n`,
    );
  }
}

function main(): void {
  const { command, options } = parseArgs(process.argv.slice(2));
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
        });
        printJson(message);
        break;
      }
      case 'close': {
        const message = store.closeMessage(getRequired(options, 'agent'), getRequired(options, 'id'));
        printJson(message);
        break;
      }
      case 'outbox': {
        const messages = store.listSent({
          agent: getRequired(options, 'from'),
          status: getOptional(options, 'status') as AgentMailStatus | undefined,
        });
        printJson(messages);
        break;
      }
      case 'search': {
        const messages = store.searchMessages({
          query: getRequired(options, 'query'),
          agent: getOptional(options, 'agent'),
          status: getOptional(options, 'status') as AgentMailStatus | undefined,
          limit: getPositiveInteger(options, 'limit', 20),
        });
        if (getBoolean(options, 'json')) {
          printJson(messages);
        } else {
          printMessageLines(messages);
        }
        break;
      }
      case 'show': {
        const result = store.getMessageWithEvents(getRequired(options, 'id'));
        if (!result) throw new Error(`Message not found: ${getRequired(options, 'id')}`);
        printJson(result);
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
      case 'audit-required': {
        const olderThanMinutes = getNonNegativeNumber(options, 'older-than-minutes', 60);
        const report = store.auditRequiredResponses({
          olderThanMs: olderThanMinutes * 60_000,
          fromAgent: getOptional(options, 'from'),
          toAgent: getOptional(options, 'to'),
        });
        printJson(report);
        if (getBoolean(options, 'fail-on-overdue') && report.overdue.length > 0) {
          process.exitCode = 2;
        }
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
