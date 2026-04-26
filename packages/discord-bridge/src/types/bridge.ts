export interface DiscordBridgeSubscription {
  agentKey: string;
  channelId: string;
  threadId?: string;
  workspaceDir?: string;
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

export interface DiscordBridgeInboxEntry {
  id: string;
  bindingName?: string;
  agentKey: string;
  channelId: string;
  threadId?: string;
  author: string;
  authorId?: string;
  content: string;
  timestamp: string;
}
