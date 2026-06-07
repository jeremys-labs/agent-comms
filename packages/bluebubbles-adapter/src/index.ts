import fs from 'node:fs';
import path from 'node:path';
import type {
  OutboundChannelAdapter,
  OutboundEnvelope,
  OutboundPolicyDecision,
} from '@agent-comms/outbound-router';

const MAX_FILES = 10;
const MAX_ATTACHMENT_SIZE = 25 * 1024 * 1024;

export interface BlueBubblesConfig {
  baseUrl: string;
  password: string;
  allowFrom: string[];
}

export interface BlueBubblesStateOptions {
  stateDir: string;
}

function parseEnv(text: string): Record<string, string> {
  return Object.fromEntries(text.split(/\r?\n/).flatMap((line) => {
    const match = line.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    return match ? [[match[1], match[2].replace(/^['"]|['"]$/g, '')]] : [];
  }));
}

export function loadBlueBubblesConfig(options: BlueBubblesStateOptions): BlueBubblesConfig {
  const env = parseEnv(fs.readFileSync(path.join(options.stateDir, '.env'), 'utf8'));
  const access = JSON.parse(fs.readFileSync(path.join(options.stateDir, 'access.json'), 'utf8')) as {
    allowFrom?: unknown;
  };
  const password = process.env.BLUEBUBBLES_PASSWORD ?? env.BLUEBUBBLES_PASSWORD ?? '';
  if (!password) throw new Error('BLUEBUBBLES_PASSWORD is required');
  return {
    baseUrl: (process.env.BLUEBUBBLES_URL ?? env.BLUEBUBBLES_URL ?? 'http://localhost:1234').replace(/\/$/, ''),
    password,
    allowFrom: Array.isArray(access.allowFrom)
      ? access.allowFrom.filter((value): value is string => typeof value === 'string')
      : [],
  };
}

export function extractBlueBubblesAddress(chatGuid: string): string | null {
  const parts = chatGuid.split(';-;');
  return parts.length >= 2 ? parts[parts.length - 1] : null;
}

export function createBlueBubblesPolicy(config: BlueBubblesConfig) {
  return (envelope: OutboundEnvelope): OutboundPolicyDecision => {
    if (envelope.channel !== 'bluebubbles') return { allowed: true, reason: 'different channel' };
    const address = extractBlueBubblesAddress(envelope.destination);
    return address && config.allowFrom.includes(address)
      ? { allowed: true, reason: 'destination is allowlisted' }
      : { allowed: false, reason: 'BlueBubbles destination is not allowlisted' };
  };
}

function apiUrl(config: BlueBubblesConfig, endpoint: string): string {
  const separator = endpoint.includes('?') ? '&' : '?';
  return `${config.baseUrl}/api/v1/${endpoint}${separator}password=${encodeURIComponent(config.password)}`;
}

async function sendText(config: BlueBubblesConfig, envelope: OutboundEnvelope): Promise<string> {
  const tempGuid = `agent-comms-${envelope.id}`;
  const response = await fetch(apiUrl(config, 'message/text'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chatGuid: envelope.destination,
      tempGuid,
      message: envelope.text,
    }),
  });
  if (!response.ok) throw new Error(`BlueBubbles text send failed ${response.status}: ${await response.text()}`);
  const result = await response.json().catch(() => null) as { data?: { guid?: string } } | null;
  return result?.data?.guid ?? tempGuid;
}

async function sendAttachment(
  config: BlueBubblesConfig,
  envelope: OutboundEnvelope,
  filePath: string,
  caption?: string,
): Promise<void> {
  const stat = fs.statSync(filePath);
  if (!stat.isFile() || stat.size === 0) throw new Error(`invalid attachment: ${filePath}`);
  if (stat.size > MAX_ATTACHMENT_SIZE) throw new Error(`attachment exceeds ${MAX_ATTACHMENT_SIZE} bytes: ${filePath}`);
  const form = new FormData();
  form.append('chatGuid', envelope.destination);
  form.append('tempGuid', `agent-comms-${envelope.id}-${path.basename(filePath)}`);
  form.append('name', path.basename(filePath));
  form.append('attachment', new Blob([new Uint8Array(fs.readFileSync(filePath))]), path.basename(filePath));
  if (caption) form.append('message', caption);
  const response = await fetch(apiUrl(config, 'message/attachment'), { method: 'POST', body: form });
  if (!response.ok) throw new Error(`BlueBubbles attachment send failed ${response.status}: ${await response.text()}`);
}

export function createBlueBubblesAdapter(config: BlueBubblesConfig): OutboundChannelAdapter {
  return {
    channel: 'bluebubbles',
    async deliver(envelope) {
      const decision = createBlueBubblesPolicy(config)(envelope);
      if (!decision.allowed) throw new Error(decision.reason);
      const files = envelope.files ?? [];
      if (files.length > MAX_FILES) throw new Error(`BlueBubbles supports at most ${MAX_FILES} files`);
      if (files.length === 0) {
        return { transportMessageId: await sendText(config, envelope) };
      }
      for (let index = 0; index < files.length; index += 1) {
        await sendAttachment(config, envelope, files[index], index === 0 ? envelope.text : undefined);
      }
      return { transportMessageId: `agent-comms-${envelope.id}` };
    },
  };
}
