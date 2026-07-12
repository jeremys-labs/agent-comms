import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  recordInboundExpected,
  recordOutboundSent,
  readReplyPolicy,
  readBreadcrumbs,
  inboundExpectedPath,
  outboundSentPath,
  replyPolicyPath,
  type InboundExpectedRecord,
  type OutboundSentRecord,
} from './reconcile-breadcrumbs.js';

let contentRoot: string;

beforeEach(() => {
  contentRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-breadcrumbs-'));
});

afterEach(() => {
  fs.rmSync(contentRoot, { recursive: true, force: true });
});

const inbound: InboundExpectedRecord = {
  queued_at: '2026-07-12T14:00:00.000Z',
  agent: 'cecelia',
  chat_id: '1521320561156948058',
  message_id: '111',
  binding: 'cecelia',
  inbox_path: '/tmp/inbox/cecelia.jsonl',
};

const outbound: OutboundSentRecord = {
  sent_at: '2026-07-12T14:03:00.000Z',
  agent: 'cecelia',
  chat_id: '1521320561156948058',
  message_id: '222',
  binding: 'cecelia',
};

describe('recordInboundExpected / recordOutboundSent', () => {
  it('appends one JSONL record per call, creating directories as needed', () => {
    recordInboundExpected(contentRoot, inbound);
    recordInboundExpected(contentRoot, { ...inbound, message_id: '112' });
    const records = readBreadcrumbs<InboundExpectedRecord>(inboundExpectedPath(contentRoot));
    expect(records).toHaveLength(2);
    expect(records[0]).toEqual(inbound);
    expect(records[1].message_id).toBe('112');
  });

  it('keeps inbound and outbound streams in separate files', () => {
    recordInboundExpected(contentRoot, inbound);
    recordOutboundSent(contentRoot, outbound);
    expect(readBreadcrumbs(inboundExpectedPath(contentRoot))).toHaveLength(1);
    expect(readBreadcrumbs<OutboundSentRecord>(outboundSentPath(contentRoot))[0]).toEqual(outbound);
  });

  it('never throws when the content root is unwritable (best-effort invariant)', () => {
    expect(() => recordInboundExpected('/dev/null/nope', inbound)).not.toThrow();
    expect(() => recordOutboundSent('/dev/null/nope', outbound)).not.toThrow();
  });
});

describe('readBreadcrumbs', () => {
  it('returns [] for a missing file', () => {
    expect(readBreadcrumbs(inboundExpectedPath(contentRoot))).toEqual([]);
  });

  it('skips torn/corrupt lines without poisoning the scan', () => {
    recordInboundExpected(contentRoot, inbound);
    fs.appendFileSync(inboundExpectedPath(contentRoot), '{"queued_at":"2026-07-12T14:0');
    fs.appendFileSync(inboundExpectedPath(contentRoot), '\n');
    recordInboundExpected(contentRoot, { ...inbound, message_id: '113' });
    const records = readBreadcrumbs<InboundExpectedRecord>(inboundExpectedPath(contentRoot));
    expect(records.map((r) => r.message_id)).toEqual(['111', '113']);
  });
});

describe('readReplyPolicy', () => {
  it('returns {} when no policy file exists (fail-open)', () => {
    expect(readReplyPolicy(contentRoot)).toEqual({});
  });

  it('returns {} on malformed JSON (fail-open)', () => {
    fs.mkdirSync(path.dirname(replyPolicyPath(contentRoot)), { recursive: true });
    fs.writeFileSync(replyPolicyPath(contentRoot), 'not json{');
    expect(readReplyPolicy(contentRoot)).toEqual({});
  });

  it('parses a valid policy with per-agent overrides and opt-outs', () => {
    fs.mkdirSync(path.dirname(replyPolicyPath(contentRoot)), { recursive: true });
    fs.writeFileSync(replyPolicyPath(contentRoot), JSON.stringify({
      defaultGraceMinutes: 10,
      agents: {
        cecelia: { graceMinutes: 20 },
        'grooming-bot': { optOut: true },
        marcus: { optOutChatIds: ['999'] },
      },
    }));
    const policy = readReplyPolicy(contentRoot);
    expect(policy.defaultGraceMinutes).toBe(10);
    expect(policy.agents?.cecelia.graceMinutes).toBe(20);
    expect(policy.agents?.['grooming-bot'].optOut).toBe(true);
    expect(policy.agents?.marcus.optOutChatIds).toEqual(['999']);
  });
});
