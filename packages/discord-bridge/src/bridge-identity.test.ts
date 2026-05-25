import { describe, expect, it } from 'vitest';
import {
  DISCORD_BRIDGE_BINARY_NAME,
  DISCORD_BRIDGE_PACKAGE_NAME,
  DISCORD_BRIDGE_ROUTE_OWNER,
  formatDiscordBridgeIdentity,
} from './bridge-identity.js';

describe('discord bridge identity', () => {
  it('names the live gateway package and binary', () => {
    expect(DISCORD_BRIDGE_PACKAGE_NAME).toBe('@agent-comms/discord-bridge');
    expect(DISCORD_BRIDGE_BINARY_NAME).toBe('agent-discord-bridge');
    expect(DISCORD_BRIDGE_ROUTE_OWNER).toBe('agent-comms');
    expect(formatDiscordBridgeIdentity()).toBe('@agent-comms/discord-bridge/agent-discord-bridge route_owner=agent-comms');
  });
});
