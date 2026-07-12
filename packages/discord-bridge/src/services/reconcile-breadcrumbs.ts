// Reconcile breadcrumbs for the inbound-reply reconciler (conversational-loop
// dead-man's-switch — sibling of the supervisor's scheduled-delivery reconciler).
//
// Two append-only JSONL records, written by the bridge at its two choke points:
//
//   inbound-expected: every inbound Discord message queued for an agent. The
//   reconciler treats each record as "a reply is now expected".
//
//   outbound-sent: every SUCCESSFUL Discord send by any agent, written only
//   after the Discord POST succeeded (same invariant the delivery reconciler
//   relies on: a failed send writes nothing). The reconciler matches these
//   against inbound-expected records by (agent, chat_id, after queued_at).
//
// Route policy (grace overrides / opt-outs) lives in a JSON file beside the
// breadcrumbs so operators can tune without redeploying the bridge; the
// reconciler decision core consumes it as input.
//
// Breadcrumb writes are best-effort: a breadcrumb failure must never break
// message routing or sending. Errors are logged and swallowed.

import fs from 'fs';
import path from 'path';

export interface InboundExpectedRecord {
  queued_at: string;      // ISO 8601, when the bridge queued the message
  agent: string;          // agentKey the message was routed to
  chat_id: string;        // Discord channel the reply is expected in
  message_id: string;     // inbound Discord message id
  binding: string;        // bridge binding name that received it
  inbox_path?: string;    // inbox jsonl file the entry was appended to
}

export interface OutboundSentRecord {
  sent_at: string;        // ISO 8601, after successful Discord POST
  agent: string;          // agentKey that sent (or 'unknown')
  chat_id: string;        // destination channel
  message_id: string;     // Discord message id of the sent message
  binding: string;        // bridge binding name that sent it
}

// Per-agent reply policy. Consumed by the reconciler decision core.
export interface AgentReplyPolicy {
  graceMinutes?: number;  // override the reconciler's default grace window
  optOut?: boolean;       // true = no reply expected from this agent, ever
  optOutChatIds?: string[]; // no reply expected in these channels only
}

export interface ReplyReconcilePolicy {
  defaultGraceMinutes?: number;
  agents?: Record<string, AgentReplyPolicy>;
}

function reconcileDir(contentRoot: string): string {
  return path.join(contentRoot, 'bridge', 'reconcile');
}

export function inboundExpectedPath(contentRoot: string): string {
  return path.join(reconcileDir(contentRoot), 'inbound-expected.jsonl');
}

export function outboundSentPath(contentRoot: string): string {
  return path.join(reconcileDir(contentRoot), 'outbound-sent.jsonl');
}

export function replyPolicyPath(contentRoot: string): string {
  return path.join(reconcileDir(contentRoot), 'reply-policy.json');
}

function appendRecord(filePath: string, record: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`);
}

export function recordInboundExpected(contentRoot: string, record: InboundExpectedRecord): void {
  try {
    appendRecord(inboundExpectedPath(contentRoot), record);
  } catch (error) {
    console.error('[discord-bridge] inbound-expected breadcrumb failed:', error);
  }
}

export function recordOutboundSent(contentRoot: string, record: OutboundSentRecord): void {
  try {
    appendRecord(outboundSentPath(contentRoot), record);
  } catch (error) {
    console.error('[discord-bridge] outbound-sent breadcrumb failed:', error);
  }
}

// Read + validate the operator-tunable policy. Missing file or bad JSON means
// "no policy" — the reconciler applies its defaults. Fail-open by design.
export function readReplyPolicy(contentRoot: string): ReplyReconcilePolicy {
  try {
    const raw = fs.readFileSync(replyPolicyPath(contentRoot), 'utf8');
    const parsed = JSON.parse(raw) as ReplyReconcilePolicy;
    if (!parsed || typeof parsed !== 'object') return {};
    return parsed;
  } catch {
    return {};
  }
}

// Scan helper for the reconciler's IO layer: parse a breadcrumb jsonl file,
// skipping unparseable lines (a torn write must not poison the scan).
export function readBreadcrumbs<T>(filePath: string): T[] {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return [];
  }
  const records: T[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed) as T);
    } catch {
      // torn/corrupt line — skip
    }
  }
  return records;
}
