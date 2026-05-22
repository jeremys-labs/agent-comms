import fs from 'fs';
import path from 'path';
import type { AgentMailMessage } from '@agent-comms/mailbox';
import type { A2ATaskRecord } from './types.js';

const DEFAULT_OPEN_BRAIN_ENV_PATH = '/Volumes/Repo-Drive/src/open-brain/credentials/ob1.env';
const DEFAULT_OPEN_BRAIN_ACCESS_KEY_PATH = '/Volumes/Repo-Drive/src/open-brain/credentials/mcp-access-key.txt';
const DEFAULT_AGENTS_ROOT = '/Volumes/Repo-Drive/agents';

interface OpenBrainRuntimeConfig {
  agentId: string;
  endpointUrl: string;
  agentMemoryKey: string;
}

export interface A2AConversationLogger {
  captureInbound(record: A2ATaskRecord, mail: AgentMailMessage): void;
  captureCompletion(record: A2ATaskRecord): void;
}

function parseEnvFile(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    env[match[1]!] = match[2]!.replace(/^['"]|['"]$/g, '');
  }
  return env;
}

function readEnvFile(filePath: string): Record<string, string> | null {
  try {
    return parseEnvFile(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function readTrimmedFile(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf8').trim();
  } catch {
    return null;
  }
}

function resolveAgentMemoryEnvPath(agentKey: string): string {
  const agentsRoot = process.env.AGENTS_ROOT ?? DEFAULT_AGENTS_ROOT;
  return path.join(agentsRoot, agentKey, '.open-brain', 'memory.env');
}

function resolveOpenBrainRuntimeConfig(agentKey: string): OpenBrainRuntimeConfig | null {
  if (process.env.OPEN_BRAIN_RUNTIME_DISABLED === '1') return null;

  const openBrainEnvPath = process.env.OPEN_BRAIN_ENV_PATH ?? DEFAULT_OPEN_BRAIN_ENV_PATH;
  const accessKeyPath = process.env.OPEN_BRAIN_ACCESS_KEY_PATH ?? DEFAULT_OPEN_BRAIN_ACCESS_KEY_PATH;
  const openBrainEnv = readEnvFile(openBrainEnvPath);
  const agentEnv = readEnvFile(resolveAgentMemoryEnvPath(agentKey));
  if (!openBrainEnv || !agentEnv) return null;

  const projectUrl = openBrainEnv.SUPABASE_PROJECT_URL;
  const mcpAccessKey = process.env.OPEN_BRAIN_MCP_ACCESS_KEY ?? readTrimmedFile(accessKeyPath);
  const agentId = agentEnv.AGENT_MEMORY_AGENT_ID ?? agentKey;
  const agentMemoryKey = agentEnv.AGENT_MEMORY_KEY;
  if (!projectUrl || !mcpAccessKey || !agentId || !agentMemoryKey) return null;

  const url = new URL('/functions/v1/open-brain-mcp', projectUrl);
  url.searchParams.set('key', mcpAccessKey);
  url.searchParams.set('agent_key', agentMemoryKey);
  return { agentId, endpointUrl: url.toString(), agentMemoryKey };
}

async function callOpenBrainTool(
  config: OpenBrainRuntimeConfig,
  name: string,
  args: Record<string, unknown>,
): Promise<void> {
  const response = await fetch(config.endpointUrl, {
    method: 'POST',
    headers: {
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
      'x-agent-memory-key': config.agentMemoryKey,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      method: 'tools/call',
      params: {
        name,
        arguments: {
          agent_key: config.agentMemoryKey,
          ...args,
        },
      },
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Open Brain ${name} failed: ${response.status} ${body}`);
  }

  const body = await response.text();
  const dataLines = body
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trim())
    .filter(Boolean);
  const payloads = dataLines.length ? dataLines : [body.trim()].filter(Boolean);
  for (const payload of payloads) {
    const parsed = JSON.parse(payload) as {
      error?: { message?: string };
      result?: { isError?: boolean; content?: Array<{ text?: unknown }> };
    };
    if (parsed.error) throw new Error(parsed.error.message ?? JSON.stringify(parsed.error));
    if (parsed.result?.isError) {
      const errorText = Array.isArray(parsed.result.content)
        ? parsed.result.content
          .map((item) => (typeof item.text === 'string' ? item.text : ''))
          .filter(Boolean)
          .join('\n')
        : '';
      throw new Error(errorText || JSON.stringify(parsed.result));
    }
  }
}

function capture(config: OpenBrainRuntimeConfig, args: Record<string, unknown>, label: string): void {
  void callOpenBrainTool(config, 'capture_agent_memory', args).catch((error) => {
    process.stderr.write(`[a2a-gateway] Open Brain ${label} capture failed (non-blocking): ${String(error)}\n`);
  });
}

export function createOpenBrainA2ALogger(): A2AConversationLogger {
  return {
    captureInbound(record, mail) {
      const config = resolveOpenBrainRuntimeConfig(record.agentKey);
      if (!config) return;
      capture(config, {
        agent_id: config.agentId,
        scope: 'raw_capture',
        project: 'external-a2a',
        audience: [config.agentId],
        authority: 'raw_capture',
        confidence: 'medium',
        source_type: 'agent_mail',
        source_ref: `a2a:${record.id}:inbound`,
        content: [
          `A2A inbound task ${record.id} for ${record.agentKey}`,
          `Remote agent: ${record.remoteAgent}`,
          record.contextId ? `Context ID: ${record.contextId}` : null,
          `Agent-mail message: ${mail.id}`,
          '',
          record.text,
        ].filter(Boolean).join('\n'),
      }, 'inbound');
    },

    captureCompletion(record) {
      if (!record.responseText || !record.responseMessageId) return;
      const config = resolveOpenBrainRuntimeConfig(record.agentKey);
      if (!config) return;
      capture(config, {
        agent_id: config.agentId,
        scope: 'private_agent',
        project: 'external-a2a',
        audience: [config.agentId],
        authority: 'context',
        confidence: 0.7,
        source_type: 'agent_mail',
        source_ref: `a2a:${record.id}:reply:${record.responseMessageId}`,
        content: [
          `A2A reply for task ${record.id}`,
          `Remote agent: ${record.remoteAgent}`,
          record.contextId ? `Context ID: ${record.contextId}` : null,
          `Agent-mail reply: ${record.responseMessageId}`,
          '',
          record.responseText,
        ].filter(Boolean).join('\n'),
      }, 'completion');
    },
  };
}
