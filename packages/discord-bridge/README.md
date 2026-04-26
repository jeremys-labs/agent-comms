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

For multi-agent-on-one-host deployments, use `bindings[]` to point each binding at whichever token env var you choose. The public default stays compatible with Claude Code's per-agent `DISCORD_BOT_TOKEN` convention.
