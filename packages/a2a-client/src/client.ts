import { readTokenFile } from './credentials.js';
import {
  A2A_TERMINAL_STATES,
  type A2AGetTaskInput,
  type A2AGetTaskResult,
  type A2APeer,
  type A2ASendMessageInput,
  type A2ASendMessageResult,
  type A2ATaskState,
} from './types.js';

function endpointUrl(peer: A2APeer): string {
  const base = peer.baseUrl.replace(/\/+$/, '');
  const path = peer.endpointPath ?? '/';
  return path.startsWith('/') ? `${base}${path}` : `${base}/${path}`;
}

function resolveToken(peer: A2APeer, override?: string): string {
  if (override) return override;
  return readTokenFile(peer.tokenFile);
}

async function postJsonRpc(
  peer: A2APeer,
  token: string,
  body: Record<string, unknown>,
  fetchImpl: typeof fetch,
): Promise<Record<string, unknown>> {
  const res = await fetchImpl(endpointUrl(peer), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  if (text.trim()) {
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch (error) {
      throw new Error(`A2A peer ${peer.key} returned non-JSON (${res.status}): ${text.slice(0, 200)}`);
    }
  }
  if (!res.ok) {
    throw new Error(`A2A peer ${peer.key} HTTP ${res.status}: ${JSON.stringify(parsed).slice(0, 200)}`);
  }
  const rpcError = parsed['error'] as { code?: number; message?: string } | undefined;
  if (rpcError) {
    throw new Error(`A2A peer ${peer.key} JSON-RPC error ${rpcError.code ?? '?'}: ${rpcError.message ?? 'unknown'}`);
  }
  return parsed;
}

function extractTaskId(rpcResult: unknown): string {
  if (!rpcResult || typeof rpcResult !== 'object') return '';
  const r = rpcResult as Record<string, unknown>;
  const candidates = ['id', 'taskId', 'task_id'] as const;
  for (const key of candidates) {
    const value = r[key];
    if (typeof value === 'string' && value) return value;
  }
  return '';
}

function extractState(rpcResult: unknown): A2ATaskState {
  if (!rpcResult || typeof rpcResult !== 'object') return 'unknown';
  const r = rpcResult as Record<string, unknown>;
  const status = r['status'] && typeof r['status'] === 'object'
    ? (r['status'] as Record<string, unknown>)
    : undefined;
  const direct = (status?.['state'] ?? r['state']) as string | undefined;
  if (!direct) return 'unknown';
  if ((A2A_TERMINAL_STATES as ReadonlySet<string>).has(direct)) return direct as A2ATaskState;
  if (direct === 'submitted' || direct === 'working') return direct;
  // A state string we don't map collapses to non-terminal 'unknown' and then
  // polls uselessly to expiry — surface it so a new peer state is noticed.
  console.warn(`[a2a-client] peer reported unrecognized task state "${direct}"; treating as unknown`);
  return 'unknown';
}

function extractText(rpcResult: unknown): string | undefined {
  if (!rpcResult || typeof rpcResult !== 'object') return undefined;
  const r = rpcResult as Record<string, unknown>;
  const status = r['status'] && typeof r['status'] === 'object'
    ? (r['status'] as Record<string, unknown>)
    : undefined;
  // status.message may be either a string (Tom's gateway on failure) or an
  // object with a `parts: [{text}]` array (A2A spec for assistant replies).
  const message = status?.['message'];
  if (typeof message === 'string' && message.trim()) return message;
  if (message && typeof message === 'object') {
    const parts = (message as Record<string, unknown>)['parts'];
    if (Array.isArray(parts)) {
      const text = parts
        .map((part) => (part && typeof part === 'object' ? (part as Record<string, unknown>)['text'] : undefined))
        .filter((piece): piece is string => typeof piece === 'string')
        .join('\n');
      if (text) return text;
    }
  }
  return undefined;
}

export async function sendMessage(input: A2ASendMessageInput): Promise<A2ASendMessageResult> {
  const token = resolveToken(input.peer, input.token);
  const fetchImpl = input.fetchImpl ?? fetch;
  const body: Record<string, unknown> = {
    jsonrpc: '2.0',
    id: input.rpcId ?? 1,
    method: 'message/send',
    params: {
      message: {
        parts: [{ text: input.text }],
        metadata: {
          ...input.metadata,
          skillId: input.skillId,
          requesterId: input.requesterId,
        },
        ...(input.contextId ? { contextId: input.contextId } : {}),
      },
    },
  };
  const rawResponse = await postJsonRpc(input.peer, token, body, fetchImpl);
  const result = rawResponse['result'];
  const taskId = extractTaskId(result);
  if (!taskId) {
    throw new Error(`A2A peer ${input.peer.key} did not return a task id; response=${JSON.stringify(rawResponse).slice(0, 200)}`);
  }
  return { taskId, rawResponse, sentAt: new Date().toISOString() };
}

export async function getTask(input: A2AGetTaskInput): Promise<A2AGetTaskResult> {
  const token = resolveToken(input.peer, input.token);
  const fetchImpl = input.fetchImpl ?? fetch;
  const body: Record<string, unknown> = {
    jsonrpc: '2.0',
    id: input.rpcId ?? 2,
    method: 'tasks/get',
    params: { id: input.taskId },
  };
  const rawResponse = await postJsonRpc(input.peer, token, body, fetchImpl);
  const result = rawResponse['result'];
  return {
    taskId: input.taskId,
    state: extractState(result),
    result: (result && typeof result === 'object') ? (result as Record<string, unknown>) : {},
    text: extractText(result),
    rawResponse,
  };
}

export async function fetchAgentCard(peer: A2APeer, fetchImpl: typeof fetch = fetch): Promise<Record<string, unknown>> {
  const base = peer.baseUrl.replace(/\/+$/, '');
  const url = `${base}/.well-known/agent-card.json`;
  const res = await fetchImpl(url);
  if (!res.ok) {
    throw new Error(`A2A peer ${peer.key} agent-card HTTP ${res.status}`);
  }
  return (await res.json()) as Record<string, unknown>;
}
