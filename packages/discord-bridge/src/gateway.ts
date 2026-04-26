#!/usr/bin/env node
import { resolveContentRoot, ensureBridgeDirs } from './paths.js';
import { loadDiscordBridgeConfig, normalizeDiscordBridgeBindings } from './bridge-config.js';
import { DiscordGatewayClient } from './services/discord-gateway-client.js';
import { appendInboxEntry, hasSeen, markSeen } from './services/bridge-store.js';
import { routeDiscordMessageForBinding } from './services/bridge-router.js';

const contentRoot = resolveContentRoot();
ensureBridgeDirs(contentRoot);

const config = loadDiscordBridgeConfig(contentRoot);
if (!config) {
  console.error('[discord-bridge] missing config file at bridge/discord.json');
  process.exit(1);
}

const bindings = normalizeDiscordBridgeBindings(config);
const clients: DiscordGatewayClient[] = [];

for (const binding of bindings) {
  const token = process.env[binding.tokenEnvVar];
  if (!token) {
    console.error(`[discord-bridge] missing Discord token in env var ${binding.tokenEnvVar} for binding ${binding.name}`);
    process.exit(1);
  }

  const client = new DiscordGatewayClient(token, (event) => {
    const routed = routeDiscordMessageForBinding(binding, event);
    if (!routed) return;

    const subscriptionKey = `${binding.name}:${routed.agentKey}:${routed.threadId ?? routed.channelId}`;
    if (hasSeen(contentRoot, subscriptionKey, routed.id)) return;

    const filePath = appendInboxEntry(contentRoot, routed);
    markSeen(contentRoot, subscriptionKey, routed.id);
    console.log(`[discord-bridge] [${binding.name}] queued ${routed.id} for ${routed.agentKey} -> ${filePath}`);
  });

  client.connect();
  clients.push(client);
  console.log(`[discord-bridge] connected binding ${binding.name}`);
}

process.on('SIGINT', () => {
  for (const client of clients) client.close();
  process.exit(0);
});

process.on('SIGTERM', () => {
  for (const client of clients) client.close();
  process.exit(0);
});
