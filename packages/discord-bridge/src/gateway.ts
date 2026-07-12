#!/usr/bin/env node
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { resolveContentRoot, ensureBridgeDirs } from './paths.js';
import { loadDiscordBridgeConfig, normalizeDiscordBridgeBindings, partitionBindingsByToken } from './bridge-config.js';
import { DiscordGatewayClient } from './services/discord-gateway-client.js';
import { parseRetryAfterMs, splitDiscordContent } from './services/discord-send.js';
import { makeSocketHealthCheck } from './services/socket-heal.js';
import { appendInboxEntry, hasSeen, markSeen } from './services/bridge-store.js';
import { recordInboundExpected, recordOutboundSent } from './services/reconcile-breadcrumbs.js';
import { routeDiscordMessageForBinding } from './services/bridge-router.js';
import { backfillBindingMessages, subscriptionKey } from './services/discord-rest-backfill.js';
import { wakeAgentRuntime } from './services/runtime-wake.js';
import { captureKnowledgeGapReply } from './services/knowledge-gap-capture.js';
import { formatDiscordBridgeIdentity } from './bridge-identity.js';

const contentRoot = resolveContentRoot();
ensureBridgeDirs(contentRoot);
console.log(`[discord-bridge] starting ${formatDiscordBridgeIdentity()}`);

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

type DiscordRequestBody = { body: Buffer; contentType: string };

function rawDiscordPost(token: string, channelId: string, requestBody: DiscordRequestBody): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; data: string }> {
  return new Promise((resolve, reject) => {
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
      res.on('end', () => resolve({ statusCode: res.statusCode ?? 500, headers: res.headers, data }));
    });
    req.on('error', reject);
    req.end(requestBody.body);
  });
}

type DiscordSendResult = {
  id: string;
  attachmentCount: number;
};

async function postDiscordMessage(token: string, channelId: string, requestBody: DiscordRequestBody): Promise<DiscordSendResult> {
  let res = await rawDiscordPost(token, channelId, requestBody);
  if (res.statusCode === 429) {
    const retryMs = parseRetryAfterMs(res.headers, res.data);
    if (retryMs !== null) {
      console.error(`[discord-bridge] rate limited (429), retrying after ${retryMs}ms`);
      await new Promise((resolve) => setTimeout(resolve, retryMs));
      res = await rawDiscordPost(token, channelId, requestBody);
    }
  }
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error(`Discord send failed ${res.statusCode}: ${res.data}`);
  }
  const parsed = JSON.parse(res.data) as { id: string; attachments?: unknown[] };
  return {
    id: parsed.id,
    attachmentCount: Array.isArray(parsed.attachments) ? parsed.attachments.length : 0,
  };
}

async function sendDiscordMessage(token: string, channelId: string, text: string | undefined, files: string[], replyTo?: string): Promise<DiscordSendResult> {
  const parts = text ? splitDiscordContent(text) : [];
  let firstSent = false;
  const takeReply = (): string | undefined => {
    const value = firstSent ? undefined : replyTo;
    firstSent = true;
    return value;
  };

  let lastId = '';
  if (files.length > 0) {
    // Leading text chunks go out as plain messages; the final message carries the files.
    for (const part of parts.slice(0, Math.max(0, parts.length - 1))) {
      const sent = await postDiscordMessage(token, channelId, { body: buildDiscordJsonBody(part, takeReply()), contentType: 'application/json' });
      lastId = sent.id;
    }
    const finalText = parts.length > 0 ? parts[parts.length - 1] : undefined;
    const sent = await postDiscordMessage(token, channelId, buildDiscordMultipartBody(finalText, files, takeReply()));
    return sent;
  }

  let lastAttachmentCount = 0;
  for (const part of parts) {
    const sent = await postDiscordMessage(token, channelId, { body: buildDiscordJsonBody(part, takeReply()), contentType: 'application/json' });
    lastId = sent.id;
    lastAttachmentCount = sent.attachmentCount;
  }
  return { id: lastId, attachmentCount: lastAttachmentCount };
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
    // Breadcrumb for the inbound-reply reconciler: written only after a
    // successful Discord POST (a failed send writes nothing).
    recordOutboundSent(contentRoot, {
      sent_at: new Date().toISOString(),
      agent: request.agentKey ?? 'unknown',
      chat_id: channelId,
      message_id: sent.id,
      binding: binding.name,
    });
    console.log(`[discord-bridge] [${binding.name}] sent ${sent.id} for ${request.agentKey ?? 'unknown'} -> ${channelId} (${sent.attachmentCount} attachment(s))`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, id: sent.id, bindingName: binding.name, attachmentCount: sent.attachmentCount }));
  } catch (error) {
    // Delivery-failure log. The shared delivery-health logger referenced in the
    // harness review lives in mcc-tmux, not this repo, so record to stderr here.
    console.error('[discord-bridge] outbound delivery failed:', error);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: String(error) }));
  }
});

function listenOnSocket(): void {
  try {
    fs.unlinkSync(socketPath);
  } catch {}
  outboundServer.listen(socketPath, () => {
    fs.chmodSync(socketPath, 0o600);
    console.log(`[discord-bridge] outbound HTTP listening on ${socketPath}`);
  });
}

listenOnSocket();

// Self-heal: if the socket file is removed out from under us (e.g. `rm -f /tmp/*`),
// re-bind instead of going silently dark until a manual restart.
const socketHealthCheck = makeSocketHealthCheck(socketPath, () => {
  console.error(`[discord-bridge] socket ${socketPath} disappeared — re-listening`);
  outboundServer.close(() => listenOnSocket());
});
const socketHealthIntervalMs = Number(process.env.DISCORD_BRIDGE_SOCKET_WATCH_MS ?? '5000');
const socketHealthTimer = socketHealthIntervalMs > 0 ? setInterval(socketHealthCheck, socketHealthIntervalMs) : null;

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

const { ready: readyBindings, missing: missingBindings } = partitionBindingsByToken(bindings, process.env);

for (const skipped of missingBindings) {
  console.error(`[discord-bridge] skipping binding ${skipped.name}: missing Discord token in env var ${skipped.tokenEnvVar}`);
}

if (readyBindings.length === 0) {
  console.error('[discord-bridge] no bindings have a Discord token configured — nothing to start');
  process.exit(1);
}

for (const binding of readyBindings) {
  const token = process.env[binding.tokenEnvVar]!;

  const client: DiscordGatewayClient = new DiscordGatewayClient(token, (event) => {
    const routed = routeDiscordMessageForBinding(binding, event, client.selfUserId);
    if (!routed) return;

    const key = subscriptionKey(binding, routed);
    if (hasSeen(contentRoot, key, routed.id)) return;

    const filePath = appendInboxEntry(contentRoot, routed);
    // Breadcrumb for the inbound-reply reconciler: a reply is now expected.
    recordInboundExpected(contentRoot, {
      queued_at: new Date().toISOString(),
      agent: routed.agentKey,
      chat_id: routed.channelId,
      message_id: routed.id,
      binding: binding.name,
      inbox_path: filePath,
    });
    const capture = captureKnowledgeGapReply(routed);
    if (capture.captured) {
      console.log(`[discord-bridge] [${binding.name}] captured knowledge-gap reply ${routed.id}`);
    }
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

console.log(`[discord-bridge] startup: ${readyBindings.length} binding(s) started, ${missingBindings.length} skipped${missingBindings.length > 0 ? ` (${missingBindings.map((skipped) => skipped.name).join(', ')})` : ''}`);

// One bad payload or one agent's fs error must never take the whole fleet down.
process.on('uncaughtException', (error) => {
  console.error('[discord-bridge] uncaught exception — keeping siblings alive:', error);
});
process.on('unhandledRejection', (reason) => {
  console.error('[discord-bridge] unhandled rejection — keeping siblings alive:', reason);
});

function shutdown(): void {
  for (const timer of backfillTimers) clearInterval(timer);
  if (socketHealthTimer) clearInterval(socketHealthTimer);
  outboundServer.close();
  for (const client of clients) client.close();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
