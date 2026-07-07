import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import express from 'express';

export type EventInboxPriority = 'low' | 'normal' | 'high';
export type EventInboxRisk = 'low' | 'medium' | 'high';
export type EventInboxStatus = 'new' | 'acked' | 'closed' | 'failed';

export interface EmitEventInput {
  source: string;
  sourceEventId: string;
  eventType: string;
  ownerAgent: string;
  routeKey: string;
  summary: string;
  payload: unknown;
  occurredAt?: string | null;
  priority?: EventInboxPriority;
  risk?: EventInboxRisk;
  dedupeKey?: string;
}

export interface EventInboxRecord {
  id: number;
  source: string;
  sourceEventId: string;
  eventType: string;
  receivedAt: string;
  occurredAt: string | null;
  ownerAgent: string;
  routeKey: string;
  priority: EventInboxPriority;
  risk: EventInboxRisk;
  status: EventInboxStatus;
  dedupeKey: string;
  summary: string;
  payload: unknown;
  attempts: number;
  lastError: string | null;
  ackedAt: string | null;
  closedAt: string | null;
  outcome: unknown;
}

export interface EventInboxStore {
  emitEvent(input: EmitEventInput): EventInboxRecord & { duplicate: boolean };
  listInbox(options: { agent: string; status?: EventInboxStatus }): EventInboxRecord[];
  ackEvent(agent: string, id: number): EventInboxRecord;
  closeEvent(agent: string, id: number, outcome?: unknown): EventInboxRecord;
  close(): void;
}

interface EventInboxRow {
  id: number;
  source: string;
  source_event_id: string;
  event_type: string;
  received_at: string;
  occurred_at: string | null;
  owner_agent: string;
  route_key: string;
  priority: EventInboxPriority;
  risk: EventInboxRisk;
  status: EventInboxStatus;
  dedupe_key: string;
  summary: string;
  payload_json: string;
  attempts: number;
  last_error: string | null;
  acked_at: string | null;
  closed_at: string | null;
  outcome_json: string | null;
}

function nowIso(): string {
  return new Date().toISOString();
}

function parseJson(value: string | null): unknown {
  if (!value) return null;
  return JSON.parse(value);
}

function rowToRecord(row: EventInboxRow): EventInboxRecord {
  return {
    id: row.id,
    source: row.source,
    sourceEventId: row.source_event_id,
    eventType: row.event_type,
    receivedAt: row.received_at,
    occurredAt: row.occurred_at,
    ownerAgent: row.owner_agent,
    routeKey: row.route_key,
    priority: row.priority,
    risk: row.risk,
    status: row.status,
    dedupeKey: row.dedupe_key,
    summary: row.summary,
    payload: parseJson(row.payload_json),
    attempts: row.attempts,
    lastError: row.last_error,
    ackedAt: row.acked_at,
    closedAt: row.closed_at,
    outcome: parseJson(row.outcome_json),
  };
}

export function createEventInboxStore(dbPath: string): EventInboxStore {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS event_inbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      source_event_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      received_at TEXT NOT NULL,
      occurred_at TEXT,
      owner_agent TEXT NOT NULL,
      route_key TEXT NOT NULL,
      priority TEXT NOT NULL,
      risk TEXT NOT NULL,
      status TEXT NOT NULL,
      dedupe_key TEXT NOT NULL UNIQUE,
      summary TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      acked_at TEXT,
      closed_at TEXT,
      outcome_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_event_inbox_owner_status ON event_inbox(owner_agent, status, id);
    CREATE INDEX IF NOT EXISTS idx_event_inbox_route ON event_inbox(route_key, id);
  `);

  const insertEvent = db.prepare(`
    INSERT INTO event_inbox (
      source, source_event_id, event_type, received_at, occurred_at, owner_agent,
      route_key, priority, risk, status, dedupe_key, summary, payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?, ?)
    ON CONFLICT(dedupe_key) DO NOTHING
  `);
  const selectByDedupe = db.prepare('SELECT * FROM event_inbox WHERE dedupe_key = ?');
  const selectByIdAndAgent = db.prepare('SELECT * FROM event_inbox WHERE id = ? AND owner_agent = ?');
  const selectInbox = db.prepare(`
    SELECT * FROM event_inbox
    WHERE owner_agent = ? AND status = ?
    ORDER BY id ASC
  `);
  const ackById = db.prepare(`
    UPDATE event_inbox SET status = 'acked', acked_at = ?
    WHERE id = ? AND owner_agent = ? AND status = 'new'
  `);
  const closeById = db.prepare(`
    UPDATE event_inbox SET status = 'closed', closed_at = ?, outcome_json = ?
    WHERE id = ? AND owner_agent = ? AND status IN ('new', 'acked', 'failed')
  `);

  function getOwnedRecord(agent: string, id: number): EventInboxRecord {
    const row = selectByIdAndAgent.get(id, agent) as EventInboxRow | undefined;
    if (!row) throw new Error(`event ${id} not found for ${agent}`);
    return rowToRecord(row);
  }

  return {
    emitEvent(input) {
      const dedupeKey = input.dedupeKey ?? `${input.source}:${input.eventType}:${input.sourceEventId}`;
      // Insert-or-ignore atomically: a concurrent duplicate webhook is deduped
      // by the DB (changes === 0) instead of racing a check-then-insert into a
      // SQLITE_CONSTRAINT 500. Re-select always returns the canonical row.
      const info = insertEvent.run(
        input.source,
        input.sourceEventId,
        input.eventType,
        nowIso(),
        input.occurredAt ?? null,
        input.ownerAgent,
        input.routeKey,
        input.priority ?? 'normal',
        input.risk ?? 'low',
        dedupeKey,
        input.summary,
        JSON.stringify(input.payload)
      );

      const row = selectByDedupe.get(dedupeKey) as EventInboxRow;
      return { ...rowToRecord(row), duplicate: info.changes === 0 };
    },
    listInbox(options) {
      return (selectInbox.all(options.agent, options.status ?? 'new') as EventInboxRow[]).map(rowToRecord);
    },
    ackEvent(agent, id) {
      const info = ackById.run(nowIso(), id, agent);
      const record = getOwnedRecord(agent, id);
      // changes === 0 on an owned row means it was not in 'new' state — an
      // already-acked/closed event must not report a silent success.
      if (info.changes === 0) throw new Error(`event ${id} is not ackable (status=${record.status})`);
      return record;
    },
    closeEvent(agent, id, outcome) {
      const info = closeById.run(nowIso(), outcome === undefined ? null : JSON.stringify(outcome), id, agent);
      const record = getOwnedRecord(agent, id);
      if (info.changes === 0) throw new Error(`event ${id} is not closable (status=${record.status})`);
      return record;
    },
    close() {
      db.close();
    },
  };
}

export function verifyGitHubSignature(rawBody: Buffer, signatureHeader: string | undefined, secret: string): boolean {
  if (!signatureHeader?.startsWith('sha256=')) return false;
  const expected = `sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  const actual = Buffer.from(signatureHeader, 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  return actual.length === expectedBuffer.length && crypto.timingSafeEqual(actual, expectedBuffer);
}

function repoFullName(payload: any): string {
  return payload?.repository?.full_name ?? 'unknown/repo';
}

function ownerForGitHubEvent(repo: string, eventType: string): string {
  if (repo === 'Med-Aware/frontDesk') return 'zara';
  if (repo === 'Med-Aware/inference') return 'hercule';
  if (repo === 'jeremys-labs/tmux-mcc') {
    if (eventType === 'workflow_run' || eventType === 'check_suite') return 'marcus';
    return 'eli';
  }
  return 'eli';
}

function priorityForGitHubEvent(eventName: string, payload: any): EventInboxPriority {
  if (eventName === 'workflow_run' && payload?.workflow_run?.conclusion === 'failure') return 'high';
  if (eventName === 'check_suite' && payload?.check_suite?.conclusion === 'failure') return 'high';
  return 'normal';
}

function githubEventSummary(eventName: string, payload: any): string {
  const repo = repoFullName(payload);
  if (eventName === 'issues') {
    return `${repo} issue ${payload?.action ?? 'event'}: #${payload?.issue?.number ?? '?'} ${payload?.issue?.title ?? ''}`.trim();
  }
  if (eventName === 'issue_comment') {
    return `${repo} issue comment ${payload?.action ?? 'event'}: #${payload?.issue?.number ?? '?'}`;
  }
  if (eventName === 'workflow_run') {
    const run = payload?.workflow_run;
    return `${repo} workflow ${run?.conclusion ?? run?.status ?? payload?.action ?? 'event'}: ${run?.name ?? 'unknown workflow'}`;
  }
  if (eventName === 'check_suite') {
    const suite = payload?.check_suite;
    return `${repo} check suite ${suite?.conclusion ?? suite?.status ?? payload?.action ?? 'event'}`;
  }
  return `${repo} GitHub ${eventName}`;
}

function githubOccurredAt(eventName: string, payload: any): string | null {
  if (eventName === 'issues') return payload?.issue?.updated_at ?? payload?.issue?.created_at ?? null;
  if (eventName === 'issue_comment') return payload?.comment?.updated_at ?? payload?.comment?.created_at ?? null;
  if (eventName === 'workflow_run') return payload?.workflow_run?.updated_at ?? payload?.workflow_run?.created_at ?? null;
  if (eventName === 'check_suite') return payload?.check_suite?.updated_at ?? payload?.check_suite?.created_at ?? null;
  return null;
}

export function normalizeGitHubWebhook(input: { eventName: string; deliveryId: string; payload: any }): EmitEventInput | null {
  const supportedEvents = new Set(['issues', 'issue_comment', 'workflow_run', 'check_suite']);
  if (!supportedEvents.has(input.eventName)) return null;
  const repo = repoFullName(input.payload);
  return {
    source: 'github',
    sourceEventId: input.deliveryId,
    eventType: input.eventName,
    ownerAgent: ownerForGitHubEvent(repo, input.eventName),
    routeKey: `github:${repo}:${input.eventName}`,
    summary: githubEventSummary(input.eventName, input.payload),
    payload: input.payload,
    occurredAt: githubOccurredAt(input.eventName, input.payload),
    priority: priorityForGitHubEvent(input.eventName, input.payload),
    risk: 'low',
    dedupeKey: `github:${input.deliveryId}`,
  };
}

export function verifyHomeAssistantToken(authHeader: string | undefined, tokenHeader: string | undefined, expectedToken: string): boolean {
  const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice('Bearer '.length).trim() : null;
  const suppliedToken = bearerToken || tokenHeader;
  if (!suppliedToken) return false;
  const actual = Buffer.from(suppliedToken, 'utf8');
  const expected = Buffer.from(expectedToken, 'utf8');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

export function homeAssistantDeliveryId(rawBody: Buffer): string {
  // No upstream delivery id, so the fallback key is the body hash alone — and
  // deliberately stable: a retry/replay of the same body must produce the SAME
  // key so it deduplicates (the primary goal for a webhook with no delivery id).
  // Trade-off: two genuinely distinct events with byte-identical bodies and no
  // upstream id collapse to one — acceptable, since we can't tell them apart.
  return crypto.createHash('sha256').update(rawBody).digest('hex');
}

function homeAssistantEventType(payload: any): string {
  return payload?.event_type ?? payload?.type ?? payload?.trigger?.event_type ?? payload?.trigger?.platform ?? 'event';
}

function homeAssistantEntityId(payload: any): string | null {
  return payload?.entity_id ?? payload?.event?.data?.entity_id ?? payload?.trigger?.entity_id ?? null;
}

function homeAssistantSummary(payload: any): string {
  if (typeof payload?.summary === 'string' && payload.summary.trim()) return payload.summary.trim();
  if (typeof payload?.message === 'string' && payload.message.trim()) return payload.message.trim();
  const type = homeAssistantEventType(payload);
  const entity = homeAssistantEntityId(payload);
  const friendlyName = payload?.friendly_name ?? payload?.device_name ?? payload?.event?.data?.friendly_name;
  const state = payload?.to_state?.state ?? payload?.state ?? payload?.event?.data?.state;
  const label = friendlyName || entity || 'Home Assistant';
  return state ? `${label}: ${type} (${state})` : `${label}: ${type}`;
}

function homeAssistantPriority(payload: any): EventInboxPriority {
  const severity = String(payload?.severity ?? payload?.priority ?? '').toLowerCase();
  const type = homeAssistantEventType(payload).toLowerCase();
  if (severity === 'high' || severity === 'critical') return 'high';
  if (type.includes('fault') || type.includes('alarm') || type.includes('battery_low')) return 'high';
  return 'normal';
}

function homeAssistantRisk(payload: any): EventInboxRisk {
  const action = String(payload?.action ?? payload?.mode ?? '').toLowerCase();
  if (action.includes('lock') || action.includes('close') || action.includes('set_')) return 'medium';
  return 'low';
}

export function normalizeHomeAssistantWebhook(input: { deliveryId: string; payload: any }): EmitEventInput {
  const type = homeAssistantEventType(input.payload);
  const entity = homeAssistantEntityId(input.payload);
  return {
    source: 'home_assistant',
    sourceEventId: input.deliveryId,
    eventType: type,
    ownerAgent: 'hank',
    routeKey: `home-assistant:${type}:${entity ?? 'general'}`,
    summary: homeAssistantSummary(input.payload),
    payload: input.payload,
    occurredAt: input.payload?.occurred_at ?? input.payload?.time_fired ?? input.payload?.event?.time_fired ?? null,
    priority: homeAssistantPriority(input.payload),
    risk: homeAssistantRisk(input.payload),
    dedupeKey: `home_assistant:${input.deliveryId}`,
  };
}

export function formatEventInboxForRuntime(event: EventInboxRecord): string {
  return [
    `[Event Inbox] New ${event.source} event for ${event.ownerAgent}.`,
    '',
    `id: ${event.id}`,
    `type: ${event.eventType}`,
    `route: ${event.routeKey}`,
    `priority: ${event.priority}`,
    `risk: ${event.risk}`,
    `summary: ${event.summary}`,
    event.risk === 'medium' || event.risk === 'high'
      ? 'guardrail: do not take actuation or external-write action unless the event policy explicitly allows it.'
      : null,
    '',
    'payload:',
    JSON.stringify(event.payload, null, 2),
  ].filter(Boolean).join('\n');
}

export interface EventWebhookRouterOptions {
  githubSecret?: string;
  homeAssistantToken?: string;
  env?: Record<string, string | undefined>;
}

export function createEventWebhookRouter(eventInbox: EventInboxStore, options: EventWebhookRouterOptions = {}) {
  const router = express.Router();
  const env = options.env ?? process.env;

  router.post('/webhooks/github', (req, res) => {
    const githubSecret = options.githubSecret ?? env.GITHUB_WEBHOOK_SECRET;
    if (!githubSecret) {
      res.status(503).json({ error: 'GITHUB_WEBHOOK_SECRET is not configured' });
      return;
    }

    const rawBody = (req as any).rawBody;
    if (!Buffer.isBuffer(rawBody)) {
      res.status(500).json({ error: 'raw webhook body was not captured' });
      return;
    }

    if (!verifyGitHubSignature(rawBody, req.header('x-hub-signature-256'), githubSecret)) {
      res.status(401).json({ error: 'invalid GitHub webhook signature' });
      return;
    }

    const eventName = req.header('x-github-event');
    const deliveryId = req.header('x-github-delivery');
    if (!eventName || !deliveryId) {
      res.status(400).json({ error: 'missing GitHub event headers' });
      return;
    }

    const event = normalizeGitHubWebhook({ eventName, deliveryId, payload: req.body });
    if (!event) {
      res.status(202).json({ ok: true, ignored: true });
      return;
    }

    const record = eventInbox.emitEvent(event);
    res.status(record.duplicate ? 200 : 202).json({
      ok: true,
      duplicate: record.duplicate,
      id: record.id,
      ownerAgent: record.ownerAgent,
      routeKey: record.routeKey,
    });
  });

  router.post('/webhooks/home-assistant', (req, res) => {
    const homeAssistantToken = options.homeAssistantToken ?? env.HOME_ASSISTANT_WEBHOOK_TOKEN;
    if (!homeAssistantToken) {
      res.status(503).json({ error: 'HOME_ASSISTANT_WEBHOOK_TOKEN is not configured' });
      return;
    }

    const rawBody = (req as any).rawBody;
    if (!Buffer.isBuffer(rawBody)) {
      res.status(500).json({ error: 'raw webhook body was not captured' });
      return;
    }

    if (!verifyHomeAssistantToken(req.header('authorization'), req.header('x-webhook-token'), homeAssistantToken)) {
      res.status(401).json({ error: 'invalid Home Assistant webhook token' });
      return;
    }

    const deliveryId = req.header('x-event-id') ?? req.header('x-request-id') ?? homeAssistantDeliveryId(rawBody);
    const event = normalizeHomeAssistantWebhook({ deliveryId, payload: req.body });
    const record = eventInbox.emitEvent(event);
    res.status(record.duplicate ? 200 : 202).json({
      ok: true,
      duplicate: record.duplicate,
      id: record.id,
      ownerAgent: record.ownerAgent,
      routeKey: record.routeKey,
    });
  });

  return router;
}
