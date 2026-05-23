/**
 * Project tag for every outbound A2A call. Donna's "private-by-default" rule:
 * - `private`     — default. Internal-fleet work; audit row records metadata only, never payload.
 * - `frontdesk`   — FrontDesk project. A2A-shareable; audit row records full payload.
 * - `inference`   — Inference project. A2A-shareable; audit row records full payload.
 */
export type A2AProjectScope = 'private' | 'frontdesk' | 'inference';

export const A2A_SHAREABLE_PROJECTS: ReadonlySet<A2AProjectScope> = new Set(['frontdesk', 'inference']);

export interface A2APeer {
  /** Stable key the client references this peer by, e.g. "tomegibson". */
  key: string;
  /** Human-readable label for logs and CLI output. */
  label: string;
  /** Base URL of the peer's gateway. JSON-RPC `message/send` POSTs land at `${baseUrl}/`. */
  baseUrl: string;
  /** Optional override for the JSON-RPC endpoint path. Defaults to "/". */
  endpointPath?: string;
  /** Absolute path to the file holding the bearer token (mode 0600). */
  tokenFile: string;
  /** Skills the peer advertises. Cached locally; refresh by calling `fetchAgentCard`. */
  advertisedSkills?: string[];
  /** Free-form notes; useful for the peer's contact, rotation cadence, etc. */
  notes?: string;
}

export interface A2APeerRegistry {
  version: 1;
  peers: A2APeer[];
}

export interface A2ASendMessageInput {
  peer: A2APeer;
  /** Token override; usually omitted (client reads `peer.tokenFile`). */
  token?: string;
  /** Skill id on the peer's gateway, e.g. "code-review". */
  skillId: string;
  /** Message body the peer's agent will read. */
  text: string;
  /** Identifier for our originating agent. Used by the peer for auth/audit. */
  requesterId: string;
  /** Optional JSON-RPC request id. Defaults to monotonic counter. */
  rpcId?: string | number;
  /** Extra metadata merged into the A2A `message.metadata` envelope. */
  metadata?: Record<string, unknown>;
  /** Optional pre-known contextId for thread continuation. */
  contextId?: string;
  /** Fetch impl override (test seam). */
  fetchImpl?: typeof fetch;
}

export interface A2ASendMessageResult {
  taskId: string;
  /** The full JSON-RPC response body, retained for audit and forensic use. */
  rawResponse: Record<string, unknown>;
  sentAt: string;
}

export interface A2AGetTaskInput {
  peer: A2APeer;
  token?: string;
  taskId: string;
  rpcId?: string | number;
  fetchImpl?: typeof fetch;
}

export type A2ATaskState =
  | 'submitted'
  | 'working'
  | 'completed'
  | 'failed'
  | 'canceled'
  | 'cancelled'
  | 'rejected'
  | 'unknown';

export const A2A_TERMINAL_STATES: ReadonlySet<A2ATaskState> = new Set([
  'completed',
  'failed',
  'canceled',
  'cancelled',
  'rejected',
]);

export interface A2AGetTaskResult {
  taskId: string;
  state: A2ATaskState;
  result: Record<string, unknown>;
  /** Free-form text the peer included with the terminal result, when present. */
  text?: string;
  rawResponse: Record<string, unknown>;
}

export interface A2APendingTaskRow {
  id: string;
  peer: string;
  baseUrl: string;
  endpointPath: string;
  tokenFile: string;
  fromAgent: string;
  skillId: string;
  taskId: string;
  project: A2AProjectScope;
  sentAt: string;
  expiresAt: string;
  callbackKind: 'agent-mail';
  callbackSubject?: string;
  correlationId?: string;
}

export interface A2AAuditRowBase {
  ts: string;
  event: 'send' | 'poll' | 'deliver' | 'timeout' | 'error';
  peer: string;
  skillId?: string;
  fromAgent?: string;
  taskId?: string;
  project: A2AProjectScope;
  /** Truncated SHA-256 fingerprint of the bearer used. Never the bearer itself. */
  tokenFingerprint: string;
  /** Counts only; never payload contents for `private` rows. */
  bytesIn?: number;
  bytesOut?: number;
  state?: A2ATaskState;
}

export interface A2AAuditRowShareable extends A2AAuditRowBase {
  /** Optional payload for FrontDesk / Inference rows. Omit for `private`. */
  payload?: { text?: string; response?: string };
}

export type A2AAuditRow = A2AAuditRowBase | A2AAuditRowShareable;
