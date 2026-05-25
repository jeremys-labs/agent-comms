export const DISCORD_BRIDGE_PACKAGE_NAME = '@agent-comms/discord-bridge';
export const DISCORD_BRIDGE_BINARY_NAME = 'agent-discord-bridge';
export const DISCORD_BRIDGE_ROUTE_OWNER = 'agent-comms';

export function formatDiscordBridgeIdentity(): string {
  return `${DISCORD_BRIDGE_PACKAGE_NAME}/${DISCORD_BRIDGE_BINARY_NAME} route_owner=${DISCORD_BRIDGE_ROUTE_OWNER}`;
}
