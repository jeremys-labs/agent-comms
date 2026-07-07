import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createEventInboxStore,
  formatEventInboxForRuntime,
  homeAssistantDeliveryId,
  normalizeGitHubWebhook,
  normalizeHomeAssistantWebhook,
  verifyGitHubSignature,
  verifyHomeAssistantToken,
  type EventInboxStore,
} from './index.js';

const tempDirs: string[] = [];
let store: EventInboxStore | null = null;

function makeStore(): EventInboxStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'event-inbox-'));
  tempDirs.push(dir);
  store = createEventInboxStore(path.join(dir, 'event-inbox.db'));
  return store;
}

afterEach(() => {
  store?.close();
  store = null;
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function sign(body: Buffer, secret: string): string {
  return `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
}

describe('event inbox', () => {
  it('stores, lists, dedupes, and owner-gates events', () => {
    const inbox = makeStore();
    const first = inbox.emitEvent({
      source: 'github',
      sourceEventId: 'delivery-1',
      eventType: 'issues',
      ownerAgent: 'zara',
      routeKey: 'github:Med-Aware/frontDesk:issues',
      summary: 'new issue',
      payload: { issue: { number: 23 } },
    });
    const duplicate = inbox.emitEvent({
      source: 'github',
      sourceEventId: 'delivery-1',
      eventType: 'issues',
      ownerAgent: 'zara',
      routeKey: 'github:Med-Aware/frontDesk:issues',
      summary: 'new issue duplicate',
      payload: {},
    });

    expect(duplicate).toMatchObject({ id: first.id, duplicate: true });
    expect(inbox.listInbox({ agent: 'zara' })).toHaveLength(1);
    expect(inbox.listInbox({ agent: 'eli' })).toEqual([]);
    expect(() => inbox.ackEvent('eli', first.id)).toThrow('not found');
    expect(inbox.ackEvent('zara', first.id)).toMatchObject({ status: 'acked' });
  });

  it('treats a re-delivered event as a duplicate without a constraint error', () => {
    const inbox = makeStore();
    const base = {
      source: 'home_assistant',
      sourceEventId: 'evt-1',
      eventType: 'battery_low',
      ownerAgent: 'hank',
      routeKey: 'home-assistant:battery_low:sensor',
      summary: 'first delivery',
      payload: { level: 18 },
    };
    const first = inbox.emitEvent(base);
    // Same dedupe key, different payload — the storage layer must dedupe via the
    // DB (INSERT ... ON CONFLICT), never surface SQLITE_CONSTRAINT as a 500.
    const second = inbox.emitEvent({ ...base, summary: 'redelivery', payload: { level: 12 } });
    expect(second).toMatchObject({ id: first.id, duplicate: true });
    expect(inbox.listInbox({ agent: 'hank' })).toHaveLength(1);
  });

  it('does not let ack or close silently succeed a second time', () => {
    const inbox = makeStore();
    const e = inbox.emitEvent({
      source: 'github',
      sourceEventId: 'd-9',
      eventType: 'issues',
      ownerAgent: 'zara',
      routeKey: 'github:repo:issues',
      summary: 's',
      payload: {},
    });
    expect(inbox.ackEvent('zara', e.id).status).toBe('acked');
    // Re-acking an already-acked event must not report success.
    expect(() => inbox.ackEvent('zara', e.id)).toThrow(/not ackable/);
    expect(inbox.closeEvent('zara', e.id, { ok: true }).status).toBe('closed');
    // Re-closing a closed event must not report success.
    expect(() => inbox.closeEvent('zara', e.id)).toThrow(/not closable/);
  });

  it('folds a receipt time into the Home Assistant delivery id so identical bodies stay distinct', () => {
    const body = Buffer.from(JSON.stringify({ event_type: 'motion' }));
    const a = homeAssistantDeliveryId(body, '2026-07-07T00:00:00.000Z');
    const b = homeAssistantDeliveryId(body, '2026-07-07T00:00:01.000Z');
    expect(a).toHaveLength(64);
    expect(a).not.toBe(b);
  });

  it('verifies and normalizes GitHub events for Zara', () => {
    const body = Buffer.from(JSON.stringify({ action: 'opened' }));
    expect(verifyGitHubSignature(body, sign(body, 'secret'), 'secret')).toBe(true);

    expect(normalizeGitHubWebhook({
      eventName: 'issues',
      deliveryId: 'delivery-zara',
      payload: {
        action: 'opened',
        repository: { full_name: 'Med-Aware/frontDesk' },
        issue: { number: 23, title: 'Webhook smoke test', created_at: '2026-06-02T03:55:06Z' },
      },
    })).toMatchObject({
      ownerAgent: 'zara',
      routeKey: 'github:Med-Aware/frontDesk:issues',
      summary: 'Med-Aware/frontDesk issue opened: #23 Webhook smoke test',
      dedupeKey: 'github:delivery-zara',
    });
  });

  it('verifies and normalizes Home Assistant events for Hank', () => {
    const rawBody = Buffer.from(JSON.stringify({ event_type: 'battery_low', entity_id: 'lock.front_door' }));
    expect(verifyHomeAssistantToken('Bearer ha-secret', undefined, 'ha-secret')).toBe(true);
    expect(homeAssistantDeliveryId(rawBody)).toHaveLength(64);

    expect(normalizeHomeAssistantWebhook({
      deliveryId: 'ha-delivery-1',
      payload: {
        event_type: 'battery_low',
        entity_id: 'lock.front_door',
        friendly_name: 'Front door lock',
        state: '18%',
      },
    })).toMatchObject({
      ownerAgent: 'hank',
      routeKey: 'home-assistant:battery_low:lock.front_door',
      summary: 'Front door lock: battery_low (18%)',
      priority: 'high',
      risk: 'low',
    });
  });

  it('formats compact runtime prompts with guardrails for risky events', () => {
    const prompt = formatEventInboxForRuntime({
      id: 1,
      source: 'home_assistant',
      sourceEventId: 'ha-1',
      eventType: 'lock_check',
      receivedAt: '2026-06-02T03:00:00Z',
      occurredAt: null,
      ownerAgent: 'hank',
      routeKey: 'home-assistant:lock_check:lock.front_door',
      priority: 'normal',
      risk: 'medium',
      status: 'new',
      dedupeKey: 'ha-1',
      summary: 'Front door unlocked at 10pm',
      payload: { entity_id: 'lock.front_door' },
      attempts: 0,
      lastError: null,
      ackedAt: null,
      closedAt: null,
      outcome: null,
    });

    expect(prompt).toContain('[Event Inbox] New home_assistant event for hank.');
    expect(prompt).toContain('guardrail: do not take actuation');
  });
});
