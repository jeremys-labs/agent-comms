import type { DiscordMessageEvent } from '../../types/bridge.js';

const discordRestPayload1508298833619058848 = {
  type: 0,
  content: 'This is what the maintainers posted:',
  mentions: [],
  mention_roles: [],
  attachments: [
    {
      id: '1508298833669656606',
      filename: 'message.txt',
      size: 4370,
      url: 'https://cdn.discordapp.com/attachments/1491979880747765810/1508298833669656606/message.txt?ex=6a150840&is=6a13b6c0&hm=52a5aed8da228497346a6bd283a42a41bd5b1c02105ac2a6a6afecab4e5759bb&',
      proxy_url: 'https://media.discordapp.net/attachments/1491979880747765810/1508298833669656606/message.txt?ex=6a150840&is=6a13b6c0&hm=52a5aed8da228497346a6bd283a42a41bd5b1c02105ac2a6a6afecab4e5759bb&',
      content_type: 'text/plain; charset=utf-8',
      original_content_type: 'text/plain',
      content_scan_version: 0,
    },
  ],
  embeds: [],
  timestamp: '2026-05-25T02:41:04.772000+00:00',
  edited_timestamp: null,
  flags: 0,
  components: [],
  id: '1508298833619058848',
  channel_id: '1491979880747765810',
  author: {
    id: '1030632000756920371',
    username: 'kingclueless_',
    avatar: 'cc8351c4d85b50ea6d10549681eebedd',
    discriminator: '0',
    public_flags: 0,
    flags: 0,
    banner: null,
    accent_color: null,
    global_name: 'Jeremy',
    avatar_decoration_data: null,
    collectibles: null,
    display_name_styles: null,
    banner_color: null,
    clan: null,
    primary_guild: null,
  },
  pinned: false,
  mention_everyone: false,
  tts: false,
};

export const discordMessage1508298833619058848: DiscordMessageEvent = discordRestPayload1508298833619058848;
