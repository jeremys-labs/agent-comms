import { describe, expect, it, vi } from 'vitest';
import { fetchDiscordChannelHistory, normalizeDiscordHistoryMessages } from './discord-history.js';

describe('discord history reader', () => {
  it('returns the read-only history shape with attachment presence for same-day Isla messages', () => {
    const messages = normalizeDiscordHistoryMessages([
      {
        id: 'm-isla-image',
        channel_id: '1493425484036309092',
        content: 'Today has a scene image.',
        author: { id: 'isla-user', username: 'Isla' },
        timestamp: '2026-07-14T12:30:00.000Z',
        attachments: [{
          id: 'att-1',
          url: 'https://cdn.discordapp.com/attachments/1493425484036309092/scene.png',
          filename: 'scene.png',
          content_type: 'image/png',
          size: 1024,
        }],
      },
    ]);

    expect(messages).toEqual([{
      id: 'm-isla-image',
      author: 'Isla',
      content: 'Today has a scene image.',
      hasAttachment: true,
      timestampIso: '2026-07-14T12:30:00.000Z',
    }]);
  });

  it('reads Discord history with the bot token kept inside the bridge process', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{
        id: 'm1',
        channel_id: 'c1',
        content: 'hello',
        author: { id: 'u1', username: 'Isla' },
        timestamp: '2026-07-14T12:00:00.000Z',
        attachments: [],
      }],
    });

    const result = await fetchDiscordChannelHistory('secret-token', {
      channelId: 'c1',
      limit: 5,
      after: '100',
    }, fetchMock);

    expect(result).toEqual([{
      id: 'm1',
      author: 'Isla',
      content: 'hello',
      hasAttachment: false,
      timestampIso: '2026-07-14T12:00:00.000Z',
    }]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://discord.com/api/v10/channels/c1/messages?limit=5&after=100');
    expect(init.headers.authorization).toBe('Bot secret-token');
  });

  it('rejects invalid limits before issuing a REST call', async () => {
    const fetchMock = vi.fn();

    await expect(fetchDiscordChannelHistory('token', { channelId: 'c1', limit: 101 }, fetchMock))
      .rejects.toThrow('history limit must be an integer from 1 to 100');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
