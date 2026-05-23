import crypto from 'node:crypto';
import { appendAuditRow } from './audit.js';
import { sendMessage } from './client.js';
import { readTokenFile, tokenFingerprint } from './credentials.js';
import { appendPendingRow, expiryFromSentAt } from './pending.js';
import { resolveA2APaths, type A2APaths } from './paths.js';
import type { A2APeer, A2AProjectScope } from './types.js';

export interface SendAndTrackInput {
  peer: A2APeer;
  fromAgent: string;
  skillId: string;
  text: string;
  project: A2AProjectScope;
  /** Override: use a particular requesterId on the wire. Defaults to `jeremys-fleet:<fromAgent>`. */
  requesterId?: string;
  /** Optional metadata merged into the JSON-RPC message. */
  metadata?: Record<string, unknown>;
  /** Optional human-readable subject for the eventual mailbox reply. */
  callbackSubject?: string;
  /** Optional correlation id to thread the result back as a `reply` rather than a new message. */
  correlationId?: string;
  paths?: A2APaths;
  fetchImpl?: typeof fetch;
}

export interface SendAndTrackResult {
  taskId: string;
  pendingRowId: string;
  sentAt: string;
}

/**
 * High-level convenience used by the CLI and downstream callers. One call:
 * - sends the JSON-RPC `message/send`
 * - appends a pending row Marcus's poller consumes
 * - writes the audit row (private-by-default redaction applied)
 */
export async function sendAndTrack(input: SendAndTrackInput): Promise<SendAndTrackResult> {
  const paths = input.paths ?? resolveA2APaths();
  const token = readTokenFile(input.peer.tokenFile);
  const requesterId = input.requesterId ?? `jeremys-fleet:${input.fromAgent}`;
  const result = await sendMessage({
    peer: input.peer,
    token,
    skillId: input.skillId,
    text: input.text,
    requesterId,
    metadata: input.metadata,
    fetchImpl: input.fetchImpl,
  });

  const pendingRowId = crypto.randomUUID();
  const expiresAt = expiryFromSentAt(result.sentAt);

  appendPendingRow(
    {
      id: pendingRowId,
      peer: input.peer.key,
      baseUrl: input.peer.baseUrl,
      endpointPath: input.peer.endpointPath ?? '/',
      tokenFile: input.peer.tokenFile,
      fromAgent: input.fromAgent,
      skillId: input.skillId,
      taskId: result.taskId,
      project: input.project,
      sentAt: result.sentAt,
      expiresAt,
      callbackKind: 'agent-mail',
      ...(input.callbackSubject ? { callbackSubject: input.callbackSubject } : {}),
      ...(input.correlationId ? { correlationId: input.correlationId } : {}),
    },
    paths,
  );

  appendAuditRow(
    {
      ts: result.sentAt,
      event: 'send',
      peer: input.peer.key,
      skillId: input.skillId,
      fromAgent: input.fromAgent,
      taskId: result.taskId,
      project: input.project,
      tokenFingerprint: tokenFingerprint(token),
      bytesOut: input.text.length,
      ...(input.project === 'private' ? {} : { payload: { text: input.text } }),
    },
    paths,
  );

  return { taskId: result.taskId, pendingRowId, sentAt: result.sentAt };
}
