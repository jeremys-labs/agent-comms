import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAgentMailStore, formatAgentMailForRuntime, resolveAgentMailDir } from './index.js';

describe('agent mail', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-mail-'));
    dbPath = path.join(tmpDir, 'agent_mail.db');
  });

  afterEach(() => {
    delete process.env.AGENT_MAIL_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('resolves AGENT_MAIL_DIR at call time', () => {
    process.env.AGENT_MAIL_DIR = tmpDir;

    expect(resolveAgentMailDir()).toBe(tmpDir);
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

  it('audits overdue required-response delivery without confusing ack with response', () => {
    const store = createAgentMailStore(dbPath);
    const base = Date.now();
    const unacked = store.send({
      fromAgent: 'eli',
      toAgent: 'marcus',
      type: 'question',
      subject: 'May 23 delivery regression',
      bodyMd: 'Submission is not proof of receipt or response.',
      requiresResponse: true,
    });
    const acked = store.send({
      fromAgent: 'eli',
      toAgent: 'isla',
      type: 'question',
      subject: 'Acknowledged but unanswered',
      bodyMd: 'Please reply.',
      requiresResponse: true,
    });
    store.ackMessage('isla', acked.id);
    const answered = store.send({
      fromAgent: 'eli',
      toAgent: 'zara',
      type: 'question',
      subject: 'Answered',
      bodyMd: 'Please reply.',
      requiresResponse: true,
    });
    store.ackMessage('zara', answered.id);
    store.reply({ actorAgent: 'zara', messageId: answered.id, bodyMd: 'Done.' });
    const normal = store.send({
      fromAgent: 'eli',
      toAgent: 'marcus',
      type: 'note',
      subject: 'No response requested',
      bodyMd: 'FYI',
    });

    const report = store.auditRequiredResponses({
      olderThanMs: 60_000,
      now: new Date(base + 120_000),
      fromAgent: 'eli',
    });

    expect(report.overdue.map((item) => [item.message.id, item.state])).toEqual([
      [unacked.id, 'unacked'],
      [acked.id, 'awaiting_response'],
    ]);
    expect(report.counts).toEqual({
      unacked: 1,
      awaiting_response: 1,
      closed_without_response: 0,
    });
    expect(report.overdue.some((item) => item.message.id === answered.id)).toBe(false);
    expect(report.overdue.some((item) => item.message.id === normal.id)).toBe(false);
    store.close();
  });

  it('surfaces required-response threads closed without a reply as orphaned', () => {
    const store = createAgentMailStore(dbPath);
    const base = Date.now();
    const message = store.send({
      fromAgent: 'eli',
      toAgent: 'marcus',
      type: 'question',
      subject: 'Closed thread double-send regression',
      bodyMd: 'A close is not a reply.',
      requiresResponse: true,
    });
    store.closeMessage('marcus', message.id);

    const report = store.auditRequiredResponses({
      olderThanMs: 0,
      now: new Date(base + 1_000),
    });

    expect(report.overdue).toHaveLength(1);
    expect(report.overdue[0]).toMatchObject({
      state: 'closed_without_response',
      message: { id: message.id },
    });
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
