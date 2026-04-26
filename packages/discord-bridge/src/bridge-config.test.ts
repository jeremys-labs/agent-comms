import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadDiscordBridgeConfig, normalizeDiscordBridgeBindings } from './bridge-config.js';

describe('loadDiscordBridgeConfig', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-bridge-config-'));
    delete process.env.DISCORD_BRIDGE_AGENT_KEY;
    delete process.env.DISCORD_BRIDGE_STATE_DIR;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.DISCORD_BRIDGE_AGENT_KEY;
    delete process.env.DISCORD_BRIDGE_STATE_DIR;
  });

  it('loads explicit bridge config json when present', () => {
    fs.mkdirSync(path.join(tmpDir, 'bridge'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'bridge', 'discord.json'),
      JSON.stringify({
        subscriptions: [{ agentKey: 'zara', channelId: '1492551894214905886' }],
      }),
    );

    const config = loadDiscordBridgeConfig(tmpDir);
    expect(config?.subscriptions[0]?.agentKey).toBe('zara');
  });

  it('normalizes a multi-binding config without collapsing bindings', () => {
    const bindings = normalizeDiscordBridgeBindings({
      bindings: [
        {
          name: 'zara',
          tokenEnvVar: 'DISCORD_BOT_TOKEN_ZARA',
          subscriptions: [{ agentKey: 'zara', channelId: '1492551894214905886' }],
        },
        {
          name: 'marcus',
          tokenEnvVar: 'DISCORD_BOT_TOKEN_MARCUS',
          subscriptions: [{ agentKey: 'marcus', channelId: '1492892431543308439' }],
        },
      ],
      subscriptions: [],
    });

    expect(bindings).toHaveLength(2);
    expect(bindings.map((binding) => binding.name)).toEqual(['zara', 'marcus']);
  });

  it('derives config from an agent discord access.json when env vars are set', () => {
    const discordStateDir = path.join(tmpDir, 'zara-discord');
    fs.mkdirSync(discordStateDir, { recursive: true });
    fs.writeFileSync(
      path.join(discordStateDir, 'access.json'),
      JSON.stringify({
        groups: {
          '1492551894214905886': { requireMention: false },
        },
      }),
    );

    process.env.DISCORD_BRIDGE_AGENT_KEY = 'zara';
    process.env.DISCORD_BRIDGE_STATE_DIR = discordStateDir;

    const config = loadDiscordBridgeConfig(tmpDir);
    expect(config?.subscriptions).toEqual([
      { agentKey: 'zara', channelId: '1492551894214905886' },
    ]);
  });
});
