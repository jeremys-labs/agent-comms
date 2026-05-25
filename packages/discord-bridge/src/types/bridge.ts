export interface DiscordBridgeSubscription {
  agentKey: string;
  channelId: string;
  threadId?: string;
  workspaceDir?: string;
  allowBotIds?: string[];
}

export interface DiscordBridgeConfig {
  bindings?: DiscordBridgeBinding[];
  tokenEnvVar?: string;
  selfUserId?: string;
  subscriptions: DiscordBridgeSubscription[];
}

export interface DiscordBridgeBinding {
  name: string;
  tokenEnvVar: string;
  selfUserId?: string;
  subscriptions: DiscordBridgeSubscription[];
}

export interface DiscordMessageEvent {
  id: string;
  channel_id: string;
  content: string;
  attachments?: DiscordMessageAttachment[];
  author?: {
    id?: string;
    username?: string;
    bot?: boolean;
  };
  guild_id?: string;
  timestamp?: string;
  referenced_message?: {
    id?: string;
    author?: {
      id?: string;
      username?: string;
    };
  } | null;
}

export interface DiscordMessageAttachment {
  id?: string;
  url: string;
  filename: string;
  content_type?: string;
  size?: number;
}

export interface DiscordBridgeInboxEntry {
  id: string;
  bindingName?: string;
  agentKey: string;
  channelId: string;
  threadId?: string;
  author: string;
  authorId?: string;
  referencedMessageId?: string;
  content: string;
  attachments?: DiscordBridgeAttachment[];
  timestamp: string;
}

export interface DiscordBridgeAttachment {
  url: string;
  filename: string;
  content_type?: string;
  size?: number;
}
