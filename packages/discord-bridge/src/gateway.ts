#!/usr/bin/env node
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { resolveContentRoot, ensureBridgeDirs } from './paths.js';
import { loadDiscordBridgeConfig, normalizeDiscordBridgeBindings } from './bridge-config.js';
import { DiscordGatewayClient } from './services/discord-gateway-client.js';
import { appendInboxEntry, hasSeen, markSeen } from './services/bridge-store.js';
import { routeDiscordMessageForBinding } from './services/bridge-router.js';
import { backfillBindingMessages, subscriptionKey } from './services/discord-rest-backfill.js';
import { wakeAgentRuntime } from './services/runtime-wake.js';

const contentRoot = resolveContentRoot();
ensureBridgeDirs(contentRoot);

const config = loadDiscordBridgeConfig(contentRoot);
if (!config) {
  console.error('[discord-bridge] missing config file at bridge/discord.json');
  process.exit(1);
}

const bindings = normalizeDiscordBridgeBindings(config);
const clients: DiscordGatewayClient[] = [];
const backfillTimers: ReturnType<typeof setInterval>[] = [];
const backfillIntervalMs = Number(process.env.DISCORD_BRIDGE_BACKFILL_INTERVAL_MS ?? '60000');
const socketPath = process.env.DISCORD_BRIDGE_SOCKET_PATH ?? '/tmp/agent-discord-bridge.sock';
const localAddress = process.env.DISCORD_BRIDGE_LOCAL_ADDRESS;

type OutboundRequest = {
  agentKey?: string;
  bindingName?: string;
  chat_id?: string;
  channelId?: string;
  text?: string;
  files?: string[];
  reply_to?: string;
};

function findOutboundBinding(request: OutboundRequest): typeof bindings[number] | null {
  const channelId = request.chat_id ?? request.channelId;
  if (!channelId) return null;

  return bindings.find((binding) => {
    if (request.bindingName && binding.name !== request.bindingName) return false;
    return binding.subscriptions.some((subscription) => (
      subscription.channelId === channelId &&
      (!request.agentKey || subscription.agentKey === request.agentKey)
    ));
  }) ?? null;
}

type DiscordFilePart = {
  filename: string;
  content: Buffer;
};

function validateRequestFiles(files: unknown): string[] {
  if (files === undefined) return [];
  if (!Array.isArray(files)) throw new Error('files must be an array');
  if (files.length > 10) throw new Error('Discord supports at most 10 file attachments');
  return files.map((filePath) => {
    if (typeof filePath !== 'string' || filePath.length === 0) throw new Error('files must contain path strings');
    if (!path.isAbsolute(filePath)) throw new Error(`file path must be absolute: ${filePath}`);
    const stat = fs.existsSync(filePath) ? fs.statSync(filePath) : null;
    if (!stat?.isFile()) throw new Error(`file path is not a readable file: ${filePath}`);
    return filePath;
  });
}

function buildDiscordJsonBody(text: string | undefined, replyTo?: string): Buffer {
  return Buffer.from(JSON.stringify({
    ...(text ? { content: text } : {}),
    ...(replyTo ? { message_reference: { message_id: replyTo, fail_if_not_exists: false } } : {}),
  }));
}

function buildDiscordMultipartBody(text: string | undefined, filePaths: string[], replyTo?: string): { body: Buffer; contentType: string } {
  const boundary = `agent-discord-bridge-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const files: DiscordFilePart[] = filePaths.map((filePath) => ({
    filename: path.basename(filePath),
    content: fs.readFileSync(filePath),
  }));
  const payload = {
    ...(text ? { content: text } : {}),
    attachments: files.map((file, index) => ({
      id: String(index),
      filename: file.filename,
    })),
    ...(replyTo ? { message_reference: { message_id: replyTo, fail_if_not_exists: false } } : {}),
  };
  const chunks: Buffer[] = [];
  const push = (value: string | Buffer) => {
    chunks.push(Buffer.isBuffer(value) ? value : Buffer.from(value));
  };

  push(`--${boundary}\r\n`);
  push('Content-Disposition: form-data; name="payload_json"\r\n');
  push('Content-Type: application/json\r\n\r\n');
  push(JSON.stringify(payload));
  push('\r\n');

  for (const [index, file] of files.entries()) {
    push(`--${boundary}\r\n`);
    push(`Content-Disposition: form-data; name="files[${index}]"; filename="${file.filename.replaceAll('"', '\\"')}"\r\n`);
    push('Content-Type: application/octet-stream\r\n\r\n');
    push(file.content);
    push('\r\n');
  }

  push(`--${boundary}--\r\n`);
  return {
    body: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

function sendDiscordMessage(token: string, channelId: string, text: string | undefined, files: string[], replyTo?: string): Promise<{ id: string }> {
  return new Promise((resolve, reject) => {
    const requestBody = files.length > 0
      ? buildDiscordMultipartBody(text, files, replyTo)
      : { body: buildDiscordJsonBody(text, replyTo), contentType: 'application/json' };
    const req = https.request({
      method: 'POST',
      host: 'discord.com',
      path: `/api/v10/channels/${channelId}/messages`,
      localAddress,
      headers: {
        Authorization: `Bot ${token}`,
        'Content-Type': requestBody.contentType,
        'Content-Length': requestBody.body.length,
      },
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if ((res.statusCode ?? 500) < 200 || (res.statusCode ?? 500) >= 300) {
          reject(new Error(`Discord send failed ${res.statusCode}: ${data}`));
          return;
        }
        try {
          resolve(JSON.parse(data) as { id: string });
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on('error', reject);
    req.end(requestBody.body);
  });
}

function readJsonBody(req: http.IncomingMessage): Promise<OutboundRequest> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 100_000) {
        reject(new Error('request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}') as OutboundRequest);
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

const outboundServer = http.createServer(async (req, res) => {
  try {
    if (req.method !== 'POST' || req.url !== '/send') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }

    const request = await readJsonBody(req);
    const channelId = request.chat_id ?? request.channelId;
    const files = validateRequestFiles(request.files);
    if (!channelId || (!request.text && files.length === 0)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'chat_id and text or files are required' }));
      return;
    }

    const binding = findOutboundBinding(request);
    if (!binding) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `channel ${channelId} is not allowlisted for ${request.agentKey ?? 'requested agent'}` }));
      return;
    }

    const token = process.env[binding.tokenEnvVar];
    if (!token) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `missing token env var ${binding.tokenEnvVar}` }));
      return;
    }

    const sent = await sendDiscordMessage(token, channelId, request.text, files, request.reply_to);
    console.log(`[discord-bridge] [${binding.name}] sent ${sent.id} for ${request.agentKey ?? 'unknown'} -> ${channelId}`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, id: sent.id, bindingName: binding.name }));
  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: String(error) }));
  }
});

try {
  fs.unlinkSync(socketPath);
} catch {}

outboundServer.listen(socketPath, () => {
  fs.chmodSync(socketPath, 0o600);
  console.log(`[discord-bridge] outbound HTTP listening on ${socketPath}`);
});

async function backfillBinding(binding: typeof bindings[number], token: string): Promise<void> {
  try {
    const result = await backfillBindingMessages(contentRoot, binding, token);
    if (result.queued > 0) {
      console.log(`[discord-bridge] [${binding.name}] backfilled ${result.queued} missed message(s)`);
      for (const agentKey of result.agents) {
        const wake = wakeAgentRuntime(agentKey);
        if (wake.attempted && wake.ok) {
          console.log(`[discord-bridge] woke ${agentKey} via ${wake.target}`);
        } else if (wake.attempted) {
          console.error(`[discord-bridge] wake failed for ${agentKey}: ${wake.reason}`);
        }
      }
    }
  } catch (error) {
    console.error(`[discord-bridge] [${binding.name}] backfill error:`, error);
  }
}

for (const binding of bindings) {
  const token = process.env[binding.tokenEnvVar];
  if (!token) {
    console.error(`[discord-bridge] missing Discord token in env var ${binding.tokenEnvVar} for binding ${binding.name}`);
    process.exit(1);
  }

  const client = new DiscordGatewayClient(token, (event) => {
    const routed = routeDiscordMessageForBinding(binding, event);
    if (!routed) return;

    const key = subscriptionKey(binding, routed);
    if (hasSeen(contentRoot, key, routed.id)) return;

    const filePath = appendInboxEntry(contentRoot, routed);
    markSeen(contentRoot, key, routed.id);
    console.log(`[discord-bridge] [${binding.name}] queued ${routed.id} for ${routed.agentKey} -> ${filePath}`);
    const wake = wakeAgentRuntime(routed.agentKey);
    if (wake.attempted && wake.ok) {
      console.log(`[discord-bridge] woke ${routed.agentKey} via ${wake.target}`);
    } else if (wake.attempted) {
      console.error(`[discord-bridge] wake failed for ${routed.agentKey}: ${wake.reason}`);
    }
  });

  client.connect();
  clients.push(client);
  console.log(`[discord-bridge] connected binding ${binding.name}`);

  if (backfillIntervalMs > 0) {
    void backfillBinding(binding, token);
    backfillTimers.push(setInterval(() => {
      void backfillBinding(binding, token);
    }, backfillIntervalMs));
  }
}

process.on('SIGINT', () => {
  for (const timer of backfillTimers) clearInterval(timer);
  outboundServer.close();
  for (const client of clients) client.close();
  process.exit(0);
});

process.on('SIGTERM', () => {
  for (const timer of backfillTimers) clearInterval(timer);
  outboundServer.close();
  for (const client of clients) client.close();
  process.exit(0);
});
