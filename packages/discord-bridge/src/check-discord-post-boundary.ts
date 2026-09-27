#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import {
  checkDiscordPostBoundary,
  loadDiscordPostInventory,
} from './services/discord-post-boundary.js';

const defaultInventory = fileURLToPath(new URL('../config/discord-post-inventory.json', import.meta.url));
const inventoryPath = process.argv[2] ?? defaultInventory;

try {
  const inventory = loadDiscordPostInventory(inventoryPath);
  const result = checkDiscordPostBoundary(inventory);
  if (!result.ok) {
    for (const finding of result.unexpected) {
      console.error(`UNINVENTORIED Discord message POST: ${finding.root}:${finding.path}`);
    }
    for (const entry of result.staleAllowlist) {
      console.error(`STALE Discord POST allowlist entry: ${entry.root}:${entry.path}`);
    }
    process.exitCode = 1;
  } else {
    const canonical = inventory.allowlist.filter((entry) => entry.disposition === 'canonical_transport').length;
    const liveBypasses = inventory.allowlist.filter((entry) => entry.disposition === 'live_noninteractive_bypass').length;
    const dormantBypasses = inventory.allowlist.filter((entry) => entry.disposition === 'dormant_bypass').length;
    console.log(`Discord POST boundary: PASS (${canonical} canonical, ${liveBypasses} live noninteractive bypasses, ${dormantBypasses} dormant bypasses)`);
  }
} catch (error) {
  console.error(`Discord POST boundary: VOID (${String(error)})`);
  process.exitCode = 2;
}
