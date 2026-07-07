import type {
  DiscordBridgeBinding,
  DiscordBridgeConfig,
  DiscordBridgeInboxEntry,
  DiscordBridgeSubscription,
  DiscordMessageEvent,
} from '../types/bridge.js';

export function matchesSubscription(
  subscription: DiscordBridgeSubscription,
  event: DiscordMessageEvent,
): boolean {
  if (subscription.threadId) {
    return event.channel_id === subscription.threadId;
  }
  return event.channel_id === subscription.channelId;
}

export function shouldIgnoreDiscordMessage(
  config: DiscordBridgeConfig,
  event: DiscordMessageEvent,
): boolean {
  if (!event.content?.trim() && !event.attachments?.length) return true;
  if (config.selfUserId && event.author?.id === config.selfUserId) return true;
  return false;
}

export function routeDiscordMessage(
  config: DiscordBridgeConfig,
  event: DiscordMessageEvent,
): DiscordBridgeInboxEntry | null {
  if (shouldIgnoreDiscordMessage(config, event)) return null;

  const subscription = config.subscriptions.find((item) => matchesSubscription(item, event));
  if (!subscription) return null;

  if (event.author?.bot && !subscription.allowBotIds?.includes(event.author.id!)) return null;

  if (subscription.requireMention && config.selfUserId) {
    const mentionsBot = event.mentions?.some((mention) => mention.id === config.selfUserId);
    if (!mentionsBot) return null;
  }

  return {
    id: event.id,
    agentKey: subscription.agentKey,
    channelId: subscription.channelId,
    threadId: subscription.threadId,
    author: event.author?.username ?? 'unknown',
    authorId: event.author?.id,
    referencedMessageId: event.referenced_message?.id,
    content: event.content,
    attachments: event.attachments?.map((attachment) => ({
      url: attachment.url,
      filename: attachment.filename,
      content_type: attachment.content_type,
      size: attachment.size,
    })),
    timestamp: event.timestamp ?? new Date().toISOString(),
  };
}

export function routeDiscordMessageForBinding(
  binding: DiscordBridgeBinding,
  event: DiscordMessageEvent,
): DiscordBridgeInboxEntry | null {
  const scopedConfig: DiscordBridgeConfig = {
    tokenEnvVar: binding.tokenEnvVar,
    selfUserId: binding.selfUserId,
    subscriptions: binding.subscriptions,
  };
  const routed = routeDiscordMessage(scopedConfig, event);
  if (!routed) return null;
  return {
    ...routed,
    bindingName: binding.name,
  };
}
