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

  describe('searchMessages', () => {
    it('finds a message by a word in the subject', () => {
      const store = createAgentMailStore(dbPath);
      const msg = store.send({
        fromAgent: 'eli',
        toAgent: 'marcus',
        type: 'question',
        subject: 'Delivery reconciler gap',
        bodyMd: 'Need to discuss the outbox write.',
      });
      store.send({
        fromAgent: 'isla',
        toAgent: 'eli',
        type: 'status',
        subject: 'Weekly standup',
        bodyMd: 'Nothing new here.',
      });

      const results = store.searchMessages({ query: 'reconciler' });
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe(msg.id);
      store.close();
    });

    it('finds a message by a word in the body', () => {
      const store = createAgentMailStore(dbPath);
      store.send({ fromAgent: 'eli', toAgent: 'marcus', type: 'note', subject: 'Topic A', bodyMd: 'Check the CONTENT_ROOT drift issue.' });
      store.send({ fromAgent: 'eli', toAgent: 'isla', type: 'note', subject: 'Topic B', bodyMd: 'Nothing related.' });

      const results = store.searchMessages({ query: 'CONTENT_ROOT' });
      expect(results).toHaveLength(1);
      expect(results[0].subject).toBe('Topic A');
      store.close();
    });

    it('returns empty array when query matches nothing', () => {
      const store = createAgentMailStore(dbPath);
      store.send({ fromAgent: 'eli', toAgent: 'marcus', type: 'note', subject: 'Hello', bodyMd: 'World.' });

      const results = store.searchMessages({ query: 'xyzzy_nonexistent_token_42' });
      expect(results).toHaveLength(0);
      store.close();
    });

    it('filters results by fromAgent', () => {
      const store = createAgentMailStore(dbPath);
      store.send({ fromAgent: 'eli', toAgent: 'marcus', type: 'note', subject: 'delivery issue', bodyMd: 'eli wrote this' });
      store.send({ fromAgent: 'isla', toAgent: 'marcus', type: 'note', subject: 'delivery issue', bodyMd: 'isla wrote this' });

      const results = store.searchMessages({ query: 'delivery', fromAgent: 'eli' });
      expect(results).toHaveLength(1);
      expect(results[0].fromAgent).toBe('eli');
      store.close();
    });

    it('filters results by toAgent', () => {
      const store = createAgentMailStore(dbPath);
      store.send({ fromAgent: 'eli', toAgent: 'marcus', type: 'note', subject: 'scheduler fix', bodyMd: 'details' });
      store.send({ fromAgent: 'eli', toAgent: 'isla', type: 'note', subject: 'scheduler fix', bodyMd: 'details' });

      const results = store.searchMessages({ query: 'scheduler', toAgent: 'isla' });
      expect(results).toHaveLength(1);
      expect(results[0].toAgent).toBe('isla');
      store.close();
    });

    it('filters results by status', () => {
      const store = createAgentMailStore(dbPath);
      const m1 = store.send({ fromAgent: 'eli', toAgent: 'marcus', type: 'question', subject: 'recall canary', bodyMd: 'status check' });
      store.send({ fromAgent: 'eli', toAgent: 'isla', type: 'question', subject: 'recall canary', bodyMd: 'status check' });
      store.ackMessage('marcus', m1.id);

      const newResults = store.searchMessages({ query: 'recall', status: 'new' });
      expect(newResults).toHaveLength(1);
      expect(newResults[0].toAgent).toBe('isla');

      const ackedResults = store.searchMessages({ query: 'recall', status: 'acked' });
      expect(ackedResults).toHaveLength(1);
      expect(ackedResults[0].id).toBe(m1.id);
      store.close();
    });

    it('respects the limit option', () => {
      const store = createAgentMailStore(dbPath);
      for (let i = 0; i < 5; i++) {
        store.send({ fromAgent: 'eli', toAgent: 'marcus', type: 'note', subject: `fleet update ${i}`, bodyMd: 'body' });
      }

      const results = store.searchMessages({ query: 'fleet', limit: 3 });
      expect(results).toHaveLength(3);
      store.close();
    });

    it('backfills existing messages opened on a fresh FTS table', () => {
      // Open db once (no messages yet — FTS empty, backfill no-ops)
      const store1 = createAgentMailStore(dbPath);
      store1.close();

      // Write a message directly via a second store (which also has the trigger, so this inserts into FTS)
      const store2 = createAgentMailStore(dbPath);
      const msg = store2.send({ fromAgent: 'eli', toAgent: 'isla', type: 'note', subject: 'backfill test subject', bodyMd: 'should be indexed' });
      store2.close();

      // Open a third store — FTS is not empty (trigger wrote it), no backfill needed; search still works
      const store3 = createAgentMailStore(dbPath);
      const results = store3.searchMessages({ query: 'backfill' });
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe(msg.id);
      store3.close();
    });
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
