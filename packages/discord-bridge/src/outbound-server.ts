import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { DiscordBridgeBinding } from './types/bridge.js';
import {
  appendOverrideAudit,
  evaluateOutboundPolicy,
  isOutboundClass,
  type OutboundOverride,
  type OutboundPolicyState,
} from './services/outbound-policy.js';

export type OutboundRequest = {
  agentKey?: string;
  bindingName?: string;
  chat_id?: string;
  channelId?: string;
  text?: string;
  files?: string[];
  reply_to?: string;
  outboundClass?: unknown;
  override?: unknown;
};

type HistoryRequest = {
  agentKey?: string;
  bindingName?: string;
  chat_id?: string;
  channelId?: string;
  limit?: number;
  before?: string;
  after?: string;
  around?: string;
};

export type DiscordSendResult = {
  id: string;
  attachmentCount: number;
};

type OutboundServerOptions = {
  bindings: DiscordBridgeBinding[];
  contentRoot: string;
  env: NodeJS.ProcessEnv;
  policyState: OutboundPolicyState;
  sendMessage: (
    token: string,
    channelId: string,
    text: string | undefined,
    files: string[],
    replyTo?: string,
  ) => Promise<DiscordSendResult>;
  fetchHistory: (
    token: string,
    request: {
      channelId: string;
      limit?: number;
      before?: string;
      after?: string;
      around?: string;
    },
  ) => Promise<unknown[]>;
  recordOutbound: (contentRoot: string, record: {
    sent_at: string;
    agent: string;
    chat_id: string;
    message_id: string;
    binding: string;
  }) => void;
  now?: () => Date;
};

function findBinding(
  bindings: DiscordBridgeBinding[],
  request: OutboundRequest | HistoryRequest,
  history: boolean,
): DiscordBridgeBinding | null {
  const channelId = request.chat_id ?? request.channelId;
  if (!channelId) return null;
  return bindings.find((binding) => {
    if (request.bindingName && binding.name !== request.bindingName) return false;
    return binding.subscriptions.some((subscription) => (
      (history ? (subscription.threadId ?? subscription.channelId) : subscription.channelId) === channelId
      && (!request.agentKey || subscription.agentKey === request.agentKey)
    ));
  }) ?? null;
}

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

function parseOverride(value: unknown): OutboundOverride | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || typeof (value as { reason?: unknown }).reason !== 'string') {
    throw new Error('override must be an object with a reason string');
  }
  return { reason: (value as { reason: string }).reason };
}

function readJsonBody<T>(req: http.IncomingMessage): Promise<T> {
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
        resolve(JSON.parse(body || '{}') as T);
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function json(res: http.ServerResponse, statusCode: number, body: unknown): void {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

export function createOutboundServer(options: OutboundServerOptions): http.Server {
  return http.createServer(async (req, res) => {
    try {
      if (req.method !== 'POST' || (req.url !== '/send' && req.url !== '/history')) {
        json(res, 404, { error: 'not found' });
        return;
      }

      if (req.url === '/history') {
        const request = await readJsonBody<HistoryRequest>(req);
        const channelId = request.chat_id ?? request.channelId;
        if (!channelId) {
          json(res, 400, { error: 'chat_id is required' });
          return;
        }
        const binding = findBinding(options.bindings, request, true);
        if (!binding) {
          json(res, 403, { error: `channel ${channelId} is not allowlisted for ${request.agentKey ?? 'requested agent'}` });
          return;
        }
        const token = options.env[binding.tokenEnvVar];
        if (!token) {
          json(res, 500, { error: `missing token env var ${binding.tokenEnvVar}` });
          return;
        }
        const messages = await options.fetchHistory(token, {
          channelId,
          limit: request.limit,
          before: request.before,
          after: request.after,
          around: request.around,
        });
        console.log(`[discord-bridge] [${binding.name}] read ${messages.length} history message(s) for ${request.agentKey ?? 'unknown'} <- ${channelId}`);
        json(res, 200, messages);
        return;
      }

      const request = await readJsonBody<OutboundRequest>(req);
      const channelId = request.chat_id ?? request.channelId;
      if (!channelId || (!request.text && (!Array.isArray(request.files) || request.files.length === 0))) {
        json(res, 400, { error: 'chat_id and text or files are required' });
        return;
      }
      const binding = findBinding(options.bindings, request, false);
      if (!binding) {
        json(res, 403, { error: `channel ${channelId} is not allowlisted for ${request.agentKey ?? 'requested agent'}` });
        return;
      }
      if (!isOutboundClass(request.outboundClass)) {
        json(res, 400, {
          error: 'invalid_outbound_class',
          repair: 'Declare outboundClass as interactive_reply, scheduled_digest, alert, or system_monitor.',
        });
        return;
      }
      const override = parseOverride(request.override);
      const policy = evaluateOutboundPolicy({
        state: options.policyState,
        agentKey: request.agentKey ?? 'unknown',
        channelId,
        outboundClass: request.outboundClass,
        text: request.text ?? '',
        override,
        auditOverride: (record) => appendOverrideAudit(options.contentRoot, record),
      });
      if (!policy.allowed) {
        json(res, policy.statusCode, policy.body);
        return;
      }

      // Policy runs before attachment validation or any delivery work. A denied
      // request cannot touch a file, split text, or attempt a Discord POST.
      const files = validateRequestFiles(request.files);
      const token = options.env[binding.tokenEnvVar];
      if (!token) {
        json(res, 500, { error: `missing token env var ${binding.tokenEnvVar}` });
        return;
      }
      const sent = await options.sendMessage(token, channelId, request.text, files, request.reply_to);
      options.recordOutbound(options.contentRoot, {
        sent_at: (options.now ?? (() => new Date()))().toISOString(),
        agent: request.agentKey ?? 'unknown',
        chat_id: channelId,
        message_id: sent.id,
        binding: binding.name,
      });
      console.log(`[discord-bridge] [${binding.name}] sent ${sent.id} for ${request.agentKey ?? 'unknown'} -> ${channelId} (${sent.attachmentCount} attachment(s))`);
      json(res, 200, {
        ok: true,
        id: sent.id,
        bindingName: binding.name,
        attachmentCount: sent.attachmentCount,
        ...(policy.overridden ? { policyOverride: true } : {}),
      });
    } catch (error) {
      console.error('[discord-bridge] outbound delivery failed:', error);
      json(res, 500, { error: String(error) });
    }
  });
}
