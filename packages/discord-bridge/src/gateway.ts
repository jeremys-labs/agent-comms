#!/usr/bin/env node
import { resolveContentRoot, ensureBridgeDirs } from './paths.js';
import { loadDiscordBridgeConfig, normalizeDiscordBridgeBindings } from './bridge-config.js';
import { DiscordGatewayClient } from './services/discord-gateway-client.js';
import { appendInboxEntry, hasSeen, markSeen } from './services/bridge-store.js';
import { routeDiscordMessageForBinding } from './services/bridge-router.js';
import { backfillBindingMessages, subscriptionKey } from './services/discord-rest-backfill.js';

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

async function backfillBinding(binding: typeof bindings[number], token: string): Promise<void> {
  try {
    const result = await backfillBindingMessages(contentRoot, binding, token);
    if (result.queued > 0) {
      console.log(`[discord-bridge] [${binding.name}] backfilled ${result.queued} missed message(s)`);
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
  });

  client.connect();
  clients.push(client);
  console.log(`[discord-bridge] connected binding ${binding.name}`);

  void backfillBinding(binding, token);
  if (backfillIntervalMs > 0) {
    backfillTimers.push(setInterval(() => {
      void backfillBinding(binding, token);
    }, backfillIntervalMs));
  }
}

process.on('SIGINT', () => {
  for (const timer of backfillTimers) clearInterval(timer);
  for (const client of clients) client.close();
  process.exit(0);
});

process.on('SIGTERM', () => {
  for (const timer of backfillTimers) clearInterval(timer);
  for (const client of clients) client.close();
  process.exit(0);
});
