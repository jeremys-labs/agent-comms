# agent-comms

Small communication primitives for local agent runtimes.

## The Problem

Local agent stacks keep rebuilding the same communication layer.

One common setup is Claude Code and Codex running side-by-side. They can both do useful work, but there is no small durable mailbox primitive they can share. A question, handoff, review request, or decision can disappear into runtime-specific chat history instead of landing in a thread both agents can inspect and close.

Another common setup is Discord as the front door for a local agent. A user sends a message in Discord, a local agent runtime needs to receive it, and the reply needs to route back to the right Discord context. Every team ends up rebuilding the gateway, routing, inbox, and local injection pieces from scratch.

## Why This Exists

Existing options tend to be either runtime-specific or framework-heavy. Claude has its own integration surface. Codex has its own runtime behavior. Agent frameworks often want to own orchestration, memory, tools, and policy.

`agent-comms` is the smaller layer underneath that: runtime-neutral communication primitives that do not try to become the framework. Use the pieces directly from a CLI, import them as libraries, or wire them into your own runtime wrapper.

## What's In The Box

- `@agent-comms/mailbox`: a durable SQLite mailbox with message threads, lifecycle events, a CLI, and a library API.
- `@agent-comms/discord-bridge`: a Discord Gateway bridge that routes Discord messages into local agent inbox files. It is drop-in compatible with Claude Code's native Discord channel configuration: use the same `DISCORD_BOT_TOKEN` env var, so existing Claude Code Discord setups can adopt the bridge without reconfiguring bot tokens.

Runtime wrappers are intentionally not a public package yet. The first extraction keeps runtime-specific PTY shims in the consuming app until the mailbox and bridge APIs settle.

## Adapters / Runtime Support

`agent-comms` is runtime-neutral, but it was built against Claude Code and Codex running side-by-side. Runtime adapters are thin shims that watch mailbox or bridge inbox state, convert events into structured prompts, inject them into the local runtime, and acknowledge delivery after successful injection. To add another runtime, implement that same adapter boundary: read the primitive state, format the event for the runtime, deliver it, then mark progress durably.

For Discord specifically, the bridge preserves Claude Code's native channel env convention: `DISCORD_BOT_TOKEN`. A fleet that already has Claude Code Discord channels configured can reuse that token environment variable while adding bridge delivery for runtimes that do not have native Discord channel support. Multi-agent-on-one-host setups can still map each bridge binding to a different token env var in config.

## Who This Is For

- People running Claude Code and Codex together locally.
- People who want Discord to be the inbox for a local agent fleet.
- People building multi-agent local stacks who do not want to reinvent durable mailbox and Discord routing primitives every time.

## Who This Is Not For

- Hosted agent platforms.
- Teams whose orchestration layer already owns inter-agent communication.
- People looking for a full agent framework.

## Quickstart

Install the packages in your project:

```bash
npm install @agent-comms/mailbox @agent-comms/discord-bridge
```

Send a mailbox message:

```bash
npx agent-mail send \
  --from eli \
  --to marcus \
  --type question \
  --subject "Need API owner" \
  --body "Who owns the next API cut?" \
  --requires-response
```

List an inbox:

```bash
npx agent-mail inbox --agent marcus --status new
```

Run the Discord bridge:

```bash
DISCORD_BOT_TOKEN=... npx agent-discord-bridge
```

### Working On agent-comms Itself

Install dependencies:

```bash
npm install
```

Run all package checks:

```bash
npm run typecheck
npm run test
npm run build
```

Use the mailbox CLI from this repo workspace:

```bash
npm run agent-mail --workspace=@agent-comms/mailbox -- \
  send \
  --from eli \
  --to marcus \
  --type question \
  --subject "Need API owner" \
  --body "Who owns the next API cut?" \
  --requires-response
```

List an inbox from this repo workspace:

```bash
npm run agent-mail --workspace=@agent-comms/mailbox -- \
  inbox --agent marcus --status new
```

Run the Discord bridge from this repo workspace:

```bash
DISCORD_BOT_TOKEN=... \
npm run bridge --workspace=@agent-comms/discord-bridge
```

## Configuration

Public defaults are intentionally generic.

`@agent-comms/mailbox` stores its database at:

```text
~/.agent-comms/mailbox/agent_mail.db
```

Override that path when a fleet already has a live shared mailbox:

```bash
AGENT_MAIL_DIR=/path/to/shared/agent-mail agent-mail inbox --agent marcus
```

This matters during migrations. If a consumer links `@agent-comms/mailbox` without setting `AGENT_MAIL_DIR`, it will create a new empty mailbox at the public default instead of reading the existing fleet database.

`@agent-comms/discord-bridge` stores bridge state at:

```text
~/.agent-comms/discord-bridge
```

Override with:

```bash
AGENT_COMMS_CONTENT_ROOT=/path/to/state agent-discord-bridge
```

By default, the Discord bridge reads config from:

```text
$AGENT_COMMS_CONTENT_ROOT/bridge/discord.json
```

Override with:

```bash
DISCORD_BRIDGE_CONFIG=/path/to/discord.json agent-discord-bridge
```

## Architecture Principles

- Runtime-neutral: no package should require a specific agent runtime.
- Primitives, not policy: expose mailbox, routing, and storage pieces without owning orchestration.
- Durable by default: messages and lifecycle events should survive process restarts.
- CLI and library: every core primitive should be usable from scripts and from application code.
- Local-first: optimized for local agent fleets and developer-controlled infrastructure.

## Status

Pre-1.0. Expect breaking changes while the packages are extracted from real usage and hardened.

These packages were extracted from a working multi-agent fleet: Claude Code and Codex agents coordinating via Discord and a shared mailbox, not designed in the abstract.

Contributions are welcome, but the public API is still settling. Open issues and small focused PRs are more useful than broad framework proposals at this stage.
