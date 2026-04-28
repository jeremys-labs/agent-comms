import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { markSeen, readBridgeState } from './bridge-store.js';
import { backfillBindingMessages } from './discord-rest-backfill.js';
import type { DiscordBridgeBinding } from '../types/bridge.js';

describe('discord REST backfill', () => {
  let tmpDir: string;
  const binding: DiscordBridgeBinding = {
    name: 'eli',
    tokenEnvVar: 'DISCORD_BOT_TOKEN_ELI',
    selfUserId: 'bot-user',
    subscriptions: [{ agentKey: 'eli', channelId: 'c1' }],
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-backfill-'));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('queues messages after the last seen id in chronological order', async () => {
    markSeen(tmpDir, 'eli:eli:c1', '100');
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        { id: '102', channel_id: 'c1', content: 'second', author: { id: 'jeremy', username: 'kingclueless_' }, timestamp: '2026-04-28T19:28:00.000Z' },
        { id: '101', channel_id: 'c1', content: 'first', author: { id: 'jeremy', username: 'kingclueless_' }, timestamp: '2026-04-28T19:27:00.000Z' },
      ],
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await backfillBindingMessages(tmpDir, binding, 'token');

    expect(result.queued).toBe(2);
    const lines = fs.readFileSync(path.join(tmpDir, 'bridge', 'inbox', 'eli.jsonl'), 'utf8').trim().split('\n');
    expect(lines.map((line) => JSON.parse(line).id)).toEqual(['101', '102']);
    expect(readBridgeState(tmpDir).lastSeenMessageIds['eli:eli:c1']).toBe('102');
  });

  it('does not backfill a subscription with no last seen id', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await backfillBindingMessages(tmpDir, binding, 'token');

    expect(result.queued).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
