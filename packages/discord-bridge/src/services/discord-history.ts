import type { DiscordMessageEvent } from '../types/bridge.js';

const DISCORD_API_BASE = 'https://discord.com/api/v10';

export interface DiscordHistoryRequest {
  channelId: string;
  limit?: number;
  before?: string;
  after?: string;
  around?: string;
}

export interface DiscordHistoryMessage {
  id: string;
  author: string;
  content: string;
  hasAttachment: boolean;
  timestampIso: string;
}

type FetchLike = typeof fetch;

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined || Number.isNaN(limit)) return 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error(`history limit must be an integer from 1 to 100: ${limit}`);
  }
  return limit;
}

export function normalizeDiscordHistoryMessages(events: DiscordMessageEvent[]): DiscordHistoryMessage[] {
  return events.map((event) => ({
    id: event.id,
    author: event.author?.username ?? event.author?.id ?? '',
    content: event.content ?? '',
    hasAttachment: Boolean(event.attachments?.length),
    timestampIso: event.timestamp ?? '',
  }));
}

export async function fetchDiscordChannelHistory(
  token: string,
  request: DiscordHistoryRequest,
  fetchImpl: FetchLike = fetch,
): Promise<DiscordHistoryMessage[]> {
  if (!request.channelId) throw new Error('channelId is required');

  const url = new URL(`${DISCORD_API_BASE}/channels/${request.channelId}/messages`);
  url.searchParams.set('limit', String(normalizeLimit(request.limit)));
  if (request.before) url.searchParams.set('before', request.before);
  if (request.after) url.searchParams.set('after', request.after);
  if (request.around) url.searchParams.set('around', request.around);

  const response = await fetchImpl(url, {
    headers: {
      authorization: `Bot ${token}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Discord history read failed for channel ${request.channelId}: ${response.status} ${response.statusText}`);
  }

  const events = await response.json() as DiscordMessageEvent[];
  return normalizeDiscordHistoryMessages(events);
}
