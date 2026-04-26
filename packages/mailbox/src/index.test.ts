import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAgentMailStore, formatAgentMailForRuntime } from './index.js';

describe('agent mail', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-mail-'));
    dbPath = path.join(tmpDir, 'agent_mail.db');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('sends, acknowledges, replies to, and closes agent mail', () => {
    const store = createAgentMailStore(dbPath);
    const message = store.send({
      fromAgent: 'eli',
      toAgent: 'marcus',
      type: 'question',
      subject: 'Need API owner',
      bodyMd: 'Who owns the next API cut?',
      relatedProject: 'mhc',
      requiresResponse: true,
    });

    expect(store.listInbox({ agent: 'marcus', status: 'new' })).toHaveLength(1);

    const acked = store.ackMessage('marcus', message.id);
    expect(acked.status).toBe('acked');

    const reply = store.reply({
      actorAgent: 'marcus',
      messageId: message.id,
      bodyMd: 'Wilber owns it.',
    });
    expect(reply.toAgent).toBe('eli');
    expect(reply.correlationId).toBe(message.correlationId);

    const closed = store.closeMessage('marcus', message.id);
    expect(closed.status).toBe('closed');
    expect(store.getThread(message.correlationId)).toHaveLength(2);
    expect(store.listEvents(message.id).map((event) => event.eventType)).toContain('replied');

    store.close();
  });

  it('formats agent mail for runtime injection', () => {
    const prompt = formatAgentMailForRuntime({
      id: 'msg_123',
      correlationId: 'corr_123',
      fromAgent: 'eli',
      toAgent: 'marcus',
      type: 'question',
      priority: 'high',
      subject: 'Need API owner',
      bodyMd: 'Who owns the next API cut?',
      relatedProject: 'mhc',
      requiresResponse: true,
      status: 'new',
      createdAt: '2026-04-24T00:00:00.000Z',
      ackedAt: null,
      closedAt: null,
    });

    expect(prompt).toContain('[Agent Mail]');
    expect(prompt).toContain('type=question');
    expect(prompt).toContain('project: mhc');
    expect(prompt).toContain('Who owns the next API cut?');
  });
});
