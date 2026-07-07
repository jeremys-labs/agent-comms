import { describe, expect, it } from 'vitest';
import { routeDiscordMessage, routeDiscordMessageForBinding, shouldIgnoreDiscordMessage } from './bridge-router.js';
import { discordMessage1508298833619058848 } from './fixtures/discord-message-1508298833619058848.js';

const config = {
  selfUserId: 'bot-user',
  subscriptions: [
    { agentKey: 'marcus', channelId: '1492892431543308439' },
    { agentKey: 'eli', channelId: '999', threadId: '12345' },
  ],
};

describe('discord bridge router', () => {
  it('routes a channel message to the matching agent', () => {
    const routed = routeDiscordMessage(config as any, {
      id: 'm1',
      channel_id: '1492892431543308439',
      content: 'Hey',
      author: { id: 'user1', username: 'Jeremy' },
      timestamp: '2026-04-13T18:00:00.000Z',
    });

    expect(routed?.agentKey).toBe('marcus');
    expect(routed?.author).toBe('Jeremy');
  });

  it('routes attachment-only messages and preserves attachment metadata', () => {
    const routed = routeDiscordMessage(config as any, {
      id: 'm-attachment',
      channel_id: '1492892431543308439',
      content: '',
      author: { id: 'user1', username: 'Jeremy' },
      attachments: [{
        id: 'a1',
        url: 'https://cdn.discordapp.com/attachments/message.txt?ex=1&is=2',
        filename: 'message.txt',
        content_type: 'text/plain; charset=utf-8',
        size: 4370,
      }],
    });

    expect(routed?.agentKey).toBe('marcus');
    expect(routed?.attachments).toEqual([{
      url: 'https://cdn.discordapp.com/attachments/message.txt?ex=1&is=2',
      filename: 'message.txt',
      content_type: 'text/plain; charset=utf-8',
      size: 4370,
    }]);
  });

  it('preserves the real Discord attachment payload that regressed on 2026-05-24', () => {
    const routed = routeDiscordMessage({
      ...config,
      subscriptions: [
        ...config.subscriptions,
        { agentKey: 'eli', channelId: '1491979880747765810' },
      ],
    } as any, discordMessage1508298833619058848);

    expect(routed?.agentKey).toBe('eli');
    expect(routed?.id).toBe('1508298833619058848');
    expect(routed?.content).toBe('This is what the maintainers posted:');
    expect(routed?.attachments).toEqual([
      {
        url: 'https://cdn.discordapp.com/attachments/1491979880747765810/1508298833669656606/message.txt?ex=6a150840&is=6a13b6c0&hm=52a5aed8da228497346a6bd283a42a41bd5b1c02105ac2a6a6afecab4e5759bb&',
        filename: 'message.txt',
        content_type: 'text/plain; charset=utf-8',
        size: 4370,
      },
    ]);
  });

  it('ignores messages from the configured self user', () => {
    expect(shouldIgnoreDiscordMessage(config as any, {
      id: 'm2',
      channel_id: '1492892431543308439',
      content: 'bot echo',
      author: { id: 'bot-user', username: 'bridge' },
    })).toBe(true);
  });

  it('routes thread traffic only to the matching thread subscription', () => {
    const routed = routeDiscordMessage(config as any, {
      id: 'm3',
      channel_id: '12345',
      content: 'thread note',
      author: { id: 'user2', username: 'Jeremy' },
    });

    expect(routed?.agentKey).toBe('eli');
    expect(routed?.threadId).toBe('12345');
  });

  it('ignores bot messages by default', () => {
    const routed = routeDiscordMessage(config as any, {
      id: 'm5',
      channel_id: '1492892431543308439',
      content: 'bot says hi',
      author: { id: 'bot-123', username: 'SomeBot', bot: true },
    });
    expect(routed).toBeNull();
  });

  it('allows bot messages when author ID is in allowBotIds', () => {
    const configWithBots = {
      ...config,
      subscriptions: [
        { agentKey: 'marcus', channelId: '1492892431543308439', allowBotIds: ['bot-123'] },
        config.subscriptions[1],
      ],
    };
    const routed = routeDiscordMessage(configWithBots as any, {
      id: 'm6',
      channel_id: '1492892431543308439',
      content: 'allowed bot says hi',
      author: { id: 'bot-123', username: 'Donna', bot: true },
    });
    expect(routed?.agentKey).toBe('marcus');
    expect(routed?.author).toBe('Donna');
  });

  it('blocks bot messages when author ID is not in allowBotIds', () => {
    const configWithBots = {
      ...config,
      subscriptions: [
        { agentKey: 'marcus', channelId: '1492892431543308439', allowBotIds: ['bot-999'] },
        config.subscriptions[1],
      ],
    };
    const routed = routeDiscordMessage(configWithBots as any, {
      id: 'm7',
      channel_id: '1492892431543308439',
      content: 'unlisted bot',
      author: { id: 'bot-123', username: 'RandomBot', bot: true },
    });
    expect(routed).toBeNull();
  });

  it('adds binding metadata when routing through a specific binding', () => {
    const routed = routeDiscordMessageForBinding({
      name: 'zara',
      tokenEnvVar: 'DISCORD_BOT_TOKEN_ZARA',
      subscriptions: [{ agentKey: 'zara', channelId: '1492551894214905886' }],
    }, {
      id: 'm4',
      channel_id: '1492551894214905886',
      content: 'hello zara',
      author: { id: 'user3', username: 'Jeremy' },
    });

    expect(routed?.bindingName).toBe('zara');
    expect(routed?.agentKey).toBe('zara');
  });

  it('drops messages that do not mention the bot when requireMention is set (M5)', () => {
    const mentionConfig = {
      selfUserId: 'bot-user',
      subscriptions: [
        { agentKey: 'marcus', channelId: '1492892431543308439', requireMention: true },
      ],
    };

    const unmentioned = routeDiscordMessage(mentionConfig as any, {
      id: 'm-nomention',
      channel_id: '1492892431543308439',
      content: 'no ping here',
      author: { id: 'user1', username: 'Jeremy' },
      mentions: [],
    });
    expect(unmentioned).toBeNull();

    const mentioned = routeDiscordMessage(mentionConfig as any, {
      id: 'm-mention',
      channel_id: '1492892431543308439',
      content: 'hey <@bot-user>',
      author: { id: 'user1', username: 'Jeremy' },
      mentions: [{ id: 'bot-user' }],
    });
    expect(mentioned?.agentKey).toBe('marcus');
  });

  it('preserves referenced message metadata for downstream reply capture', () => {
    const routed = routeDiscordMessage(config as any, {
      id: 'm8',
      channel_id: '1492892431543308439',
      content: 'reply body',
      author: { id: 'user1', username: 'Jeremy' },
      referenced_message: { id: 'question-1' },
    });

    expect(routed?.referencedMessageId).toBe('question-1');
  });
});
