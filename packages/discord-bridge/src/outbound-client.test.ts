import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  formatDirectDiscordSendFailure,
  logDirectDiscordSendFailure,
} from './delivery-health.js';
import { sendDiscordViaBridge } from './outbound-client.js';

const sockets: http.Server[] = [];
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(sockets.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function socketServer(
  handler: (request: Record<string, unknown>) => { status: number; body: unknown },
): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-outbound-'));
  dirs.push(dir);
  const socketPath = path.join(dir, 'bridge.sock');
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const response = handler(JSON.parse(body) as Record<string, unknown>);
      res.writeHead(response.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(response.body));
    });
  });
  sockets.push(server);
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return socketPath;
}

describe('sendDiscordViaBridge', () => {
  it('sends scheduler metadata through the shared bridge socket', async () => {
    const socketPath = await socketServer((request) => {
      expect(request).toMatchObject({
        agentKey: 'isla',
        chat_id: 'hq',
        text: 'alert',
        source: 'scheduled_runtime',
        job_id: 'watchdog',
      });
      return { status: 200, body: { ok: true, id: 'm1', bindingName: 'isla' } };
    });

    await expect(sendDiscordViaBridge({
      agentKey: 'isla',
      chat_id: 'hq',
      text: 'alert',
      source: 'scheduled_runtime',
      job_id: 'watchdog',
    }, { socketPath })).resolves.toEqual({ ok: true, id: 'm1', bindingName: 'isla' });
  });

  it('rejects a non-2xx bridge response', async () => {
    const socketPath = await socketServer(() => ({ status: 403, body: { error: 'not allowlisted' } }));
    await expect(sendDiscordViaBridge({
      agentKey: 'isla',
      chat_id: 'hq',
      text: 'alert',
    }, { socketPath })).rejects.toThrow('Discord bridge send failed 403');
  });
});

describe('canonical delivery-health logger', () => {
  it('formats and appends the fleet-wide direct-token failure line', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-health-'));
    dirs.push(dir);
    const logPath = path.join(dir, 'health.log');
    logDirectDiscordSendFailure('watchdog', 'hq', 403, 'Missing Access', logPath);
    expect(formatDirectDiscordSendFailure('watchdog', 'hq', 403, 'Missing Access'))
      .toBe('watchdog direct-token Discord POST FAILED to chat hq: status=403 Missing Access');
    expect(fs.readFileSync(logPath, 'utf8')).toContain('direct-token Discord POST FAILED');
  });
});

