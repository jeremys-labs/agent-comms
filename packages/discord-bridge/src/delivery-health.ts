import fs from 'node:fs';
import path from 'node:path';

export function discordSendHealthLogPath(): string {
  return process.env.DISCORD_SEND_HEALTH_LOG
    ?? '/Volumes/Repo-Drive/agents/SHARED/discord-send-health.log';
}

export function formatDirectDiscordSendFailure(
  sender: string,
  channelId: string,
  status: number,
  body: string,
): string {
  return `${sender} direct-token Discord POST FAILED to chat ${channelId}: status=${status} ${body.slice(0, 300)}`;
}

export function logDirectDiscordSendFailure(
  sender: string,
  channelId: string,
  status: number,
  body: string,
  logPath: string = discordSendHealthLogPath(),
): void {
  const failure = formatDirectDiscordSendFailure(sender, channelId, status, body);
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, `${new Date().toISOString()} [discord-send] ${failure}\n`, {
      mode: 0o600,
    });
  } catch {
    // Best-effort: delivery-health logging must never mask the send failure.
  }
  console.error(`[discord-send] ${failure}`);
}

