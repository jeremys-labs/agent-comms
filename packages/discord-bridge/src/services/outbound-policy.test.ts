import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  evaluateOutboundPolicy,
  inspectInteractiveReply,
  loadOutboundPolicyRegistry,
  type OutboundPolicyState,
} from './outbound-policy.js';

const POLICY_STATE: OutboundPolicyState = {
  ok: true,
  registry: {
    version: 1,
    policies: [{ channelId: 'jeremy', outboundClass: 'interactive_reply', maxChars: 40 }],
  },
};

function decide(text: string, overrides: Partial<Parameters<typeof evaluateOutboundPolicy>[0]> = {}) {
  return evaluateOutboundPolicy({
    state: POLICY_STATE,
    agentKey: 'zara',
    channelId: 'jeremy',
    outboundClass: 'interactive_reply',
    text,
    ...overrides,
  });
}

describe('Jeremy-bound outbound policy', () => {
  it('blocks the fully materialized overlength reply before chunking can launder it', () => {
    const decision = decide('A'.repeat(41));
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.body.ruleIds).toContain('eli5.length');
  });

  it.each([
    ['uuid', 'The job 123e4567-e89b-12d3-a456-426614174000 failed.', 'eli5.uuid'],
    ['path', 'See /Volumes/Repo-Drive/agents/zara/index.md.', 'eli5.file_path'],
    ['filename', 'The check in worker.ts failed.', 'eli5.file_name'],
    ['ledger id', 'Commitment dc-20260927-002 is open.', 'eli5.ledger_id'],
  ])('blocks %s jargon', (_name, text, ruleId) => {
    const violations = inspectInteractiveReply(text, 2_000);
    expect(violations.map((violation) => violation.ruleId)).toContain(ruleId);
  });

  it('blocks document formatting', () => {
    const violations = inspectInteractiveReply('## Status\nDetails', 2_000);
    expect(violations.map((violation) => violation.ruleId)).toContain('eli5.document_shape');
  });

  it('strips URLs before lexical checks', () => {
    const violations = inspectInteractiveReply(
      'Reference: https://example.com/jobs.json/worker.ts/123e4567-e89b-12d3-a456-426614174000',
      2_000,
    );
    expect(violations).toEqual([]);
  });

  it('returns structured rule ids, repair text, and the honest limitation', () => {
    const decision = decide('Run worker.ts now.');
    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;
    expect(decision.statusCode).toBe(422);
    expect(decision.body.ruleIds).toEqual(['eli5.file_name']);
    expect(decision.body.repair).toContain('plain English');
    expect(decision.body.limitation).toBe(
      'This catches mechanically recognizable jargon, shape and length. It cannot catch plain English that still assumes context Jeremy doesn\'t have.',
    );
  });

  it('fails closed for interactive replies when policy loading fails', () => {
    const decision = decide('Plain message.', { state: { ok: false, error: 'missing' } });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.body.ruleIds).toEqual(['eli5.policy_unavailable']);
  });

  it('does not apply interactive rules to a declared digest', () => {
    const decision = decide('## Digest\n/Volumes/Repo-Drive', { outboundClass: 'scheduled_digest' });
    expect(decision).toEqual({ allowed: true, overridden: false });
  });

  it('requires a reason and successful audit write for an override', () => {
    expect(decide('Run worker.ts now.', { override: { reason: 'short' } }).allowed).toBe(false);

    const auditOverride = vi.fn();
    const allowed = decide('Run worker.ts now.', {
      override: { reason: 'Jeremy explicitly requested the exact filename.' },
      auditOverride,
    });
    expect(allowed).toEqual({ allowed: true, overridden: true });
    expect(auditOverride).toHaveBeenCalledWith(expect.objectContaining({
      agentKey: 'zara',
      channelId: 'jeremy',
      ruleIds: ['eli5.file_name'],
    }));

    const failedAudit = decide('Run worker.ts now.', {
      override: { reason: 'Jeremy explicitly requested the exact filename.' },
      auditOverride: () => { throw new Error('disk full'); },
    });
    expect(failedAudit.allowed).toBe(false);
    if (!failedAudit.allowed) expect(failedAudit.body.ruleIds).toEqual(['eli5.override_audit_failed']);
  });

  it('rejects a malformed or duplicate registry', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-policy-'));
    const file = path.join(root, 'policy.json');
    fs.writeFileSync(file, JSON.stringify({
      version: 1,
      policies: [
        { channelId: '123', outboundClass: 'interactive_reply' },
        { channelId: '123', outboundClass: 'interactive_reply' },
      ],
    }));
    const state = loadOutboundPolicyRegistry(file);
    expect(state.ok).toBe(false);
  });
});
