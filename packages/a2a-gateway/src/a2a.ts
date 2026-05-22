import { createAgentMailStore, type AgentMailStore } from '@agent-comms/mailbox';
import type {
  A2AGatewayAgent,
  A2AGatewayConfig,
  A2ATaskRecord,
  JsonRpcRequest,
  JsonRpcResponse,
} from './types.js';
import { A2ATaskStore } from './store.js';

function createTaskId(): string {
  return `a2a_${Math.random().toString(36).slice(2, 10)}`;
}

function agentUrl(config: A2AGatewayConfig, agentKey: string): string {
  return `${config.baseUrl}/a2a/${encodeURIComponent(agentKey)}`;
}

export function buildAgentCard(config: A2AGatewayConfig, agent: A2AGatewayAgent): Record<string, unknown> {
  return {
    protocolVersion: '0.3.0',
    name: agent.name,
    description: agent.description,
    url: agentUrl(config, agent.key),
    version: '0.1.0',
    capabilities: {
      streaming: false,
      pushNotifications: false,
      stateTransitionHistory: true,
    },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: agent.skills,
    securitySchemes: config.bearerToken
      ? {
          bearer: {
            type: 'http',
            scheme: 'bearer',
          },
        }
      : {},
    security: config.bearerToken ? [{ bearer: [] }] : [],
  };
}

export function findAgent(config: A2AGatewayConfig, agentKey: string): A2AGatewayAgent | null {
  return config.agents.find((agent) => agent.key === agentKey) ?? null;
}

function textFromPart(part: unknown): string {
  if (!part || typeof part !== 'object') return '';
  const p = part as Record<string, unknown>;
  if (typeof p['text'] === 'string') return p['text'];
  const text = (p['text'] as { text?: unknown } | undefined)?.text;
  if (typeof text === 'string') return text;
  return '';
}

export function extractMessageText(params: unknown): string {
  if (!params || typeof params !== 'object') return '';
  const p = params as Record<string, unknown>;
  const message = (p['message'] && typeof p['message'] === 'object')
    ? p['message'] as Record<string, unknown>
    : p;
  if (typeof message['text'] === 'string') return message['text'];
  const parts = Array.isArray(message['parts']) ? message['parts'] : [];
  return parts.map(textFromPart).filter(Boolean).join('\n').trim();
}

function extractRemoteAgent(params: unknown): string {
  if (!params || typeof params !== 'object') return 'external';
  const p = params as Record<string, unknown>;
  const metadata = (p['metadata'] && typeof p['metadata'] === 'object')
    ? p['metadata'] as Record<string, unknown>
    : {};
  const remote = metadata['remoteAgent'] ?? metadata['fromAgent'] ?? metadata['sender'];
  return typeof remote === 'string' && remote.trim() ? remote.trim() : 'external';
}

function extractContextId(params: unknown): string | null {
  if (!params || typeof params !== 'object') return null;
  const p = params as Record<string, unknown>;
  const message = (p['message'] && typeof p['message'] === 'object')
    ? p['message'] as Record<string, unknown>
    : p;
  const contextId = p['contextId'] ?? message['contextId'];
  return typeof contextId === 'string' && contextId.trim() ? contextId.trim() : null;
}

function taskResult(record: A2ATaskRecord): Record<string, unknown> {
  const responseText = record.responseText ?? `Task ${record.state}; local message ${record.messageId}`;
  return {
    id: record.id,
    contextId: record.contextId,
    status: {
      state: record.state,
      timestamp: record.updatedAt,
      message: {
        role: 'agent',
        parts: [{ kind: 'text', text: responseText }],
      },
    },
    metadata: {
      localAgent: record.agentKey,
      remoteAgent: record.remoteAgent,
      agentMailMessageId: record.messageId,
      responseMessageId: record.responseMessageId,
    },
  };
}

function refreshTaskFromAgentMail(
  task: A2ATaskRecord,
  mailStore: AgentMailStore,
  taskStore: A2ATaskStore,
): A2ATaskRecord {
  if (task.state === 'completed' || task.state === 'failed' || task.state === 'canceled') return task;
  const thread = mailStore.getThread(task.correlationId);
  const reply = thread.find((message) => (
    message.id !== task.messageId
    && message.fromAgent === task.agentKey
    && message.toAgent === `a2a:${task.remoteAgent}`
  ));
  if (!reply) return task;
  return taskStore.update({
    ...task,
    state: 'completed',
    responseMessageId: reply.id,
    responseText: reply.bodyMd,
  });
}

export interface A2AHandlerDeps {
  config: A2AGatewayConfig;
  taskStore?: A2ATaskStore;
  mailStore?: AgentMailStore;
}

export function handleA2ARequest(
  agentKey: string,
  request: JsonRpcRequest,
  deps: A2AHandlerDeps,
): JsonRpcResponse {
  const id = request.id ?? null;
  const agent = findAgent(deps.config, agentKey);
  if (!agent) {
    return { jsonrpc: '2.0', id, error: { code: -32004, message: `Unknown agent: ${agentKey}` } };
  }

  if (request.method === 'tasks/get') {
    const params = request.params as { id?: unknown } | undefined;
    const taskId = typeof params?.id === 'string' ? params.id : '';
    const taskStore = deps.taskStore ?? new A2ATaskStore();
    const task = taskStore.get(taskId);
    if (!task) return { jsonrpc: '2.0', id, error: { code: -32001, message: `Task not found: ${taskId}` } };
    const mailStore = deps.mailStore ?? createAgentMailStore();
    const refreshed = refreshTaskFromAgentMail(task, mailStore, taskStore);
    return { jsonrpc: '2.0', id, result: taskResult(refreshed) };
  }

  if (request.method !== 'message/send') {
    return { jsonrpc: '2.0', id, error: { code: -32601, message: `Unsupported A2A method: ${request.method ?? 'unknown'}` } };
  }

  const text = extractMessageText(request.params);
  if (!text) {
    return { jsonrpc: '2.0', id, error: { code: -32602, message: 'message/send requires a text part' } };
  }

  const remoteAgent = extractRemoteAgent(request.params);
  const contextId = extractContextId(request.params);
  const taskId = createTaskId();
  const mailStore = deps.mailStore ?? createAgentMailStore();
  const taskStore = deps.taskStore ?? new A2ATaskStore();
  const mail = mailStore.send({
    fromAgent: `a2a:${remoteAgent}`,
    toAgent: agent.key,
    type: 'question',
    priority: 'normal',
    subject: `A2A task from ${remoteAgent}`,
    bodyMd: [
      `[A2A] External task ${taskId} for ${agent.name}`,
      '',
      `Remote agent: ${remoteAgent}`,
      contextId ? `Context ID: ${contextId}` : null,
      '',
      text,
    ].filter(Boolean).join('\n'),
    requiresResponse: true,
    links: [{ label: 'a2a-task', target: taskId }],
  });
  const now = new Date().toISOString();
  const record: A2ATaskRecord = {
    id: taskId,
    agentKey: agent.key,
    remoteAgent,
    contextId,
    messageId: mail.id,
    correlationId: mail.correlationId,
    state: 'submitted',
    text,
    createdAt: now,
    updatedAt: now,
  };
  taskStore.append(record);
  return { jsonrpc: '2.0', id, result: taskResult(record) };
}
