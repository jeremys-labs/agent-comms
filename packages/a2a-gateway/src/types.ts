export type A2ATaskState = 'submitted' | 'working' | 'completed' | 'failed' | 'canceled';

export interface A2AGatewayAgent {
  key: string;
  name: string;
  description: string;
  skills: Array<{
    id: string;
    name: string;
    description: string;
    tags?: string[];
  }>;
}

export interface A2AGatewayConfig {
  baseUrl: string;
  host: string;
  port: number;
  bearerToken?: string;
  agents: A2AGatewayAgent[];
}

export interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export interface A2ATaskRecord {
  id: string;
  agentKey: string;
  remoteAgent: string;
  contextId: string | null;
  messageId: string;
  correlationId: string;
  state: A2ATaskState;
  text: string;
  responseMessageId?: string;
  responseText?: string;
  createdAt: string;
  updatedAt: string;
}
