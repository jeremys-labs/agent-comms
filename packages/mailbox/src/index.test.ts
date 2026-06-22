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

  it('listSent returns messages sent by a given agent', () => {
    const store = createAgentMailStore(dbPath);
    const m1 = store.send({ fromAgent: 'eli', toAgent: 'marcus', type: 'question', subject: 'Q1', bodyMd: 'body' });
    const m2 = store.send({ fromAgent: 'eli', toAgent: 'isla', type: 'status', subject: 'S1', bodyMd: 'body' });
    store.send({ fromAgent: 'marcus', toAgent: 'eli', type: 'note', subject: 'N1', bodyMd: 'body' });

    const sent = store.listSent({ agent: 'eli' });
    expect(sent.map((m) => m.id)).toEqual(expect.arrayContaining([m1.id, m2.id]));
    expect(sent.every((m) => m.fromAgent === 'eli')).toBe(true);
    expect(sent).toHaveLength(2);
    store.close();
  });

  it('listSent filters by status', () => {
    const store = createAgentMailStore(dbPath);
    const m1 = store.send({ fromAgent: 'eli', toAgent: 'marcus', type: 'question', subject: 'Q1', bodyMd: 'body' });
    const m2 = store.send({ fromAgent: 'eli', toAgent: 'isla', type: 'status', subject: 'S1', bodyMd: 'body' });
    store.ackMessage('marcus', m1.id);

    expect(store.listSent({ agent: 'eli', status: 'new' }).map((m) => m.id)).toEqual([m2.id]);
    expect(store.listSent({ agent: 'eli', status: 'acked' }).map((m) => m.id)).toEqual([m1.id]);
    store.close();
  });

  it('listSent returns messages newest-first', () => {
    const store = createAgentMailStore(dbPath);
    const m1 = store.send({ fromAgent: 'eli', toAgent: 'marcus', type: 'note', subject: 'A', bodyMd: 'body' });
    const m2 = store.send({ fromAgent: 'eli', toAgent: 'isla', type: 'note', subject: 'B', bodyMd: 'body' });

    const sent = store.listSent({ agent: 'eli' });
    expect(sent[0].id).toBe(m2.id);
    expect(sent[1].id).toBe(m1.id);
    store.close();
  });

  it('getMessageWithEvents returns null for unknown id', () => {
    const store = createAgentMailStore(dbPath);
    expect(store.getMessageWithEvents('msg_unknown')).toBeNull();
    store.close();
  });

  it('getMessageWithEvents returns message and its event log', () => {
    const store = createAgentMailStore(dbPath);
    const sent = store.send({ fromAgent: 'eli', toAgent: 'marcus', type: 'question', subject: 'Q', bodyMd: 'body', requiresResponse: true });
    store.ackMessage('marcus', sent.id);
    store.reply({ actorAgent: 'marcus', messageId: sent.id, bodyMd: 'answer' });

    const result = store.getMessageWithEvents(sent.id);
    expect(result).not.toBeNull();
    expect(result!.message.id).toBe(sent.id);
    expect(result!.message.status).toBe('acked');
    const eventTypes = result!.events.map((e) => e.eventType);
    expect(eventTypes).toContain('created');
    expect(eventTypes).toContain('acked');
    expect(eventTypes).toContain('replied');
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
