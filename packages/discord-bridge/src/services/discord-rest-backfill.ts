import type { DiscordBridgeBinding, DiscordBridgeInboxEntry, DiscordBridgeSubscription, DiscordMessageEvent } from '../types/bridge.js';
import { getLastSeen, hasSeen, markSeen, appendInboxEntry } from './bridge-store.js';
import { routeDiscordMessageForBinding } from './bridge-router.js';
import { captureKnowledgeGapReply } from './knowledge-gap-capture.js';

const DISCORD_API_BASE = 'https://discord.com/api/v10';

export interface BackfillResult {
  queued: number;
  agents: string[];
}

export function subscriptionKey(binding: DiscordBridgeBinding, entry: Pick<DiscordBridgeInboxEntry, 'agentKey' | 'channelId' | 'threadId'>): string {
  return `${binding.name}:${entry.agentKey}:${entry.threadId ?? entry.channelId}`;
}

function snowflakeCompare(a: string, b: string): number {
  const left = BigInt(a);
  const right = BigInt(b);
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function uniqueSubscriptions(subscriptions: DiscordBridgeSubscription[]): DiscordBridgeSubscription[] {
  const seen = new Set<string>();
  const result: DiscordBridgeSubscription[] = [];

  for (const subscription of subscriptions) {
    const key = `${subscription.agentKey}:${subscription.threadId ?? subscription.channelId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(subscription);
  }

  return result;
}

async function fetchMessagesAfter(token: string, channelId: string, after: string): Promise<DiscordMessageEvent[]> {
  const url = new URL(`${DISCORD_API_BASE}/channels/${channelId}/messages`);
  url.searchParams.set('after', after);
  url.searchParams.set('limit', '100');

  const response = await fetch(url, {
    headers: {
      authorization: `Bot ${token}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Discord REST backfill failed for channel ${channelId}: ${response.status} ${response.statusText}`);
  }

  return await response.json() as DiscordMessageEvent[];
}

export async function backfillBindingMessages(contentRoot: string, binding: DiscordBridgeBinding, token: string): Promise<BackfillResult> {
  let queued = 0;
  const agents = new Set<string>();

  for (const subscription of uniqueSubscriptions(binding.subscriptions)) {
    const channelId = subscription.threadId ?? subscription.channelId;
    const key = `${binding.name}:${subscription.agentKey}:${channelId}`;
    const after = getLastSeen(contentRoot, key);
    if (!after) continue;

    const events = await fetchMessagesAfter(token, channelId, after);
    events.sort((a, b) => snowflakeCompare(a.id, b.id));

    for (const event of events) {
      const routed = routeDiscordMessageForBinding(binding, event);
      if (!routed) continue;

      const routedKey = subscriptionKey(binding, routed);
      if (hasSeen(contentRoot, routedKey, routed.id)) continue;

      appendInboxEntry(contentRoot, routed);
      captureKnowledgeGapReply(routed);
      markSeen(contentRoot, routedKey, routed.id);
      queued += 1;
      agents.add(routed.agentKey);
    }
  }

  return { queued, agents: [...agents].sort() };
}
