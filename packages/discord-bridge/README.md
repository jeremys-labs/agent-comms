# @agent-comms/discord-bridge

Discord Gateway bridge for routing Discord messages into local agent runtimes.

The package provides:

- a push-based Discord Gateway client
- subscription-based routing from Discord channels/threads to local agent keys
- JSONL inbox storage for runtime adapters
- a CLI exposed as `agent-discord-bridge`

## Status

Pre-1.0. The package is being extracted from a working local deployment and the public API is not stable yet.

## Storage

By default, bridge state is stored under:

```text
~/.agent-comms/discord-bridge
```

Override with:

```bash
AGENT_COMMS_CONTENT_ROOT=/path/to/state agent-discord-bridge
```

## Config

Create:

```text
$AGENT_COMMS_CONTENT_ROOT/bridge/discord.json
```

Example:

```json
{
  "bindings": [
    {
      "name": "marcus",
          "tokenEnvVar": "DISCORD_BOT_TOKEN",
      "selfUserId": "123456789012345678",
      "subscriptions": [
        {
          "agentKey": "marcus",
          "channelId": "1492892431543308439"
        }
      ]
    }
  ]
}
```

Then run:

```bash
DISCORD_BOT_TOKEN=... agent-discord-bridge
```

## Multiple Agents On One Host

For a single agent, keep the Claude Code-compatible default:

```bash
DISCORD_BOT_TOKEN=... agent-discord-bridge
```

For multiple agents hosted by one bridge process, use a distinct Discord bot token for each agent identity. The token is the bot identity on the Discord Gateway; separate tokens keep routing, permissions, message authorship, and replies separated by agent.

Use `bindings[]` to point each agent binding at the token env var and subscriptions it should own:

```json
{
  "bindings": [
    {
      "name": "marcus",
      "tokenEnvVar": "MARCUS_DISCORD_BOT_TOKEN",
      "subscriptions": [
        { "agentKey": "marcus", "channelId": "1492892431543308439" }
      ]
    },
    {
      "name": "zara",
      "tokenEnvVar": "ZARA_DISCORD_BOT_TOKEN",
      "subscriptions": [
        { "agentKey": "zara", "channelId": "1492551894214905886" }
      ]
    }
  ]
}
```

Those env var names are examples. The public default stays compatible with Claude Code's per-agent `DISCORD_BOT_TOKEN` convention.
