import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOutboundServer, type DiscordSendResult } from './outbound-server.js';
import type { DiscordBridgeBinding } from './types/bridge.js';
import type { OutboundPolicyState } from './services/outbound-policy.js';

const ACTIVE_BINDINGS = [
  ['isla', '1493425484036309092'],
  ['marcus', '1492892431543308439'],
  ['eli', '1491965464736436366'],
  ['nova', '1494170649651052554'],
  ['remy', '1492159200531583067'],
  ['lena', '1492537718876672130'],
  ['val', '1495580090682183820'],
  ['zara', '1492551894214905886'],
  ['hercule', '1501436731264602223'],
  ['hank', '1508217656958779494'],
  ['simone', '1531066499161133247'],
  ['cecelia', '1521320561156948058'],
  ['dana', '1531066562172293200'],
] as const;

const bindings: DiscordBridgeBinding[] = ACTIVE_BINDINGS.map(([agentKey, channelId]) => ({
  name: agentKey,
  tokenEnvVar: `TOKEN_${agentKey.toUpperCase()}`,
  subscriptions: [{ agentKey, channelId }],
}));

const env = Object.fromEntries(bindings.map((binding) => [binding.tokenEnvVar, `token-${binding.name}`]));
const policyState: OutboundPolicyState = {
  ok: true,
  registry: {
    version: 1,
    policies: ACTIVE_BINDINGS.map(([, channelId]) => ({
      channelId,
      outboundClass: 'interactive_reply',
      maxChars: 80,
    })),
  },
};

function postJson(socketPath: string, body: unknown): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = http.request({
      socketPath,
      path: '/send',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (response) => {
      let responseBody = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { responseBody += chunk; });
      response.on('end', () => resolve({
        statusCode: response.statusCode ?? 500,
        body: JSON.parse(responseBody) as Record<string, unknown>,
      }));
    });
    request.on('error', reject);
    request.end(payload);
  });
}

describe('outbound server policy integration', () => {
  let root: string;
  let socketPath: string;
  let server: ReturnType<typeof createOutboundServer>;
  let sendMessage: ReturnType<typeof vi.fn<(token: string, channelId: string) => Promise<DiscordSendResult>>>;

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-outbound-server-'));
    socketPath = path.join(root, 'bridge.sock');
    sendMessage = vi.fn(async (_token: string, channelId: string) => ({
      id: `sent-${channelId}`,
      attachmentCount: 0,
    }));
    server = createOutboundServer({
      bindings,
      contentRoot: root,
      env,
      policyState,
      sendMessage,
      fetchHistory: vi.fn(async () => []),
      recordOutbound: vi.fn(),
      now: () => new Date('2026-09-27T19:00:00.000Z'),
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('passes one compliant interactive fixture for every active binding through the real socket', async () => {
    for (const [agentKey, channelId] of ACTIVE_BINDINGS) {
      const response = await postJson(socketPath, {
        agentKey,
        chat_id: channelId,
        outboundClass: 'interactive_reply',
        text: 'The reminder is ready. Nothing needed from you.',
      });
      expect(response.statusCode, agentKey).toBe(200);
      expect(response.body).toMatchObject({ ok: true, bindingName: agentKey });
    }
    expect(sendMessage).toHaveBeenCalledTimes(ACTIVE_BINDINGS.length);
  });

  it('denies the unsplit original before attachment validation or any Discord POST', async () => {
    const response = await postJson(socketPath, {
      agentKey: 'zara',
      chat_id: '1492551894214905886',
      outboundClass: 'interactive_reply',
      text: `${'A'.repeat(90)} worker.ts`,
      files: ['/path/that/must/not/be/read.png'],
    });
    expect(response.statusCode).toBe(422);
    expect(response.body).toMatchObject({
      error: 'outbound_policy_denied',
      ruleIds: expect.arrayContaining(['eli5.length', 'eli5.file_name']),
    });
    expect(String(response.body.repair)).toContain('plain English');
    expect(String(response.body.limitation)).toContain('cannot catch plain English');
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('requires every sender to declare the outbound class', async () => {
    const response = await postJson(socketPath, {
      agentKey: 'zara',
      chat_id: '1492551894214905886',
      text: 'Plain reply.',
    });
    expect(response.statusCode).toBe(400);
    expect(response.body.error).toBe('invalid_outbound_class');
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
