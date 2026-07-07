import fs from 'fs';
import path from 'path';
import type { DiscordBridgeBinding, DiscordBridgeConfig } from './types/bridge.js';

export function discordBridgeConfigPath(contentRoot: string): string {
  const override = process.env.DISCORD_BRIDGE_CONFIG;
  if (override) return override;
  return path.join(contentRoot, 'bridge', 'discord.json');
}

export function loadDiscordBridgeConfig(contentRoot: string): DiscordBridgeConfig | null {
  const filePath = discordBridgeConfigPath(contentRoot);
  if (fs.existsSync(filePath)) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as DiscordBridgeConfig;
  }

  const agentKey = process.env.DISCORD_BRIDGE_AGENT_KEY;
  const discordStateDir = process.env.DISCORD_BRIDGE_STATE_DIR;
  if (!agentKey || !discordStateDir) return null;

  const accessPath = path.join(discordStateDir, 'access.json');
  if (!fs.existsSync(accessPath)) return null;

  const access = JSON.parse(fs.readFileSync(accessPath, 'utf8')) as {
    groups?: Record<string, { requireMention?: boolean }>;
  };

  const groups = access.groups ?? {};
  const groupIds = Object.keys(groups);
  if (groupIds.length === 0) return null;

  const derivedBinding: DiscordBridgeBinding = {
    name: agentKey,
    tokenEnvVar: 'DISCORD_BOT_TOKEN',
    subscriptions: groupIds.map((channelId) => ({
      agentKey,
      channelId,
      ...(groups[channelId]?.requireMention ? { requireMention: true } : {}),
    })),
  };

  return {
    bindings: [derivedBinding],
    tokenEnvVar: derivedBinding.tokenEnvVar,
    subscriptions: derivedBinding.subscriptions,
  };
}

export function normalizeDiscordBridgeBindings(config: DiscordBridgeConfig): DiscordBridgeBinding[] {
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

export function partitionBindingsByToken(
  bindings: DiscordBridgeBinding[],
  env: NodeJS.ProcessEnv,
): { ready: DiscordBridgeBinding[]; missing: Array<{ name: string; tokenEnvVar: string }> } {
  const ready: DiscordBridgeBinding[] = [];
  const missing: Array<{ name: string; tokenEnvVar: string }> = [];
  for (const binding of bindings) {
    if (env[binding.tokenEnvVar]) {
      ready.push(binding);
    } else {
      missing.push({ name: binding.name, tokenEnvVar: binding.tokenEnvVar });
    }
  }
  return { ready, missing };
}
