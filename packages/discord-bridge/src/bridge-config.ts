import fs from 'fs';
import path from 'path';
import type { CodexBridgeBinding, CodexBridgeConfig } from './types/bridge.js';

export function discordBridgeConfigPath(contentRoot: string): string {
  const override = process.env.DISCORD_BRIDGE_CONFIG ?? process.env.CODEX_BRIDGE_CONFIG;
  if (override) return override;
  return path.join(contentRoot, 'bridge', 'discord.json');
}

export const codexBridgeConfigPath = discordBridgeConfigPath;

export function loadCodexBridgeConfig(contentRoot: string): CodexBridgeConfig | null {
  const filePath = discordBridgeConfigPath(contentRoot);
  if (fs.existsSync(filePath)) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as CodexBridgeConfig;
  }

  const agentKey = process.env.DISCORD_BRIDGE_AGENT_KEY ?? process.env.CODEX_BRIDGE_AGENT_KEY;
  const discordStateDir = process.env.DISCORD_BRIDGE_STATE_DIR ?? process.env.CODEX_BRIDGE_DISCORD_STATE_DIR;
  if (!agentKey || !discordStateDir) return null;

  const accessPath = path.join(discordStateDir, 'access.json');
  if (!fs.existsSync(accessPath)) return null;

  const access = JSON.parse(fs.readFileSync(accessPath, 'utf8')) as {
    groups?: Record<string, { requireMention?: boolean }>;
  };

  const groupIds = Object.keys(access.groups ?? {});
  if (groupIds.length === 0) return null;

  const derivedBinding: CodexBridgeBinding = {
    name: agentKey,
    tokenEnvVar: 'DISCORD_BOT_TOKEN',
    subscriptions: groupIds.map((channelId) => ({
      agentKey,
      channelId,
    })),
  };

  return {
    bindings: [derivedBinding],
    tokenEnvVar: derivedBinding.tokenEnvVar,
    subscriptions: derivedBinding.subscriptions,
  };
}

export function normalizeCodexBridgeBindings(config: CodexBridgeConfig): CodexBridgeBinding[] {
  if (config.bindings && config.bindings.length > 0) {
    return config.bindings;
  }

  return [{
    name: 'default',
    tokenEnvVar: config.tokenEnvVar ?? 'DISCORD_BOT_TOKEN',
    selfUserId: config.selfUserId,
    subscriptions: config.subscriptions,
  }];
}
