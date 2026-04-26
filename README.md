# agent-comms

Pre-1.0 agent communication primitives for local agent runtimes.

This repository is intentionally public early. APIs, CLI flags, file layouts, and package boundaries may change while the packages are shaped against real usage.

## Packages

- `@agent-comms/mailbox` - durable local mailbox with threaded messages, CLI commands, and a library API.
- `@agent-comms/discord-bridge` - planned Discord to local runtime bridge.

## Status

`@agent-comms/mailbox` is being extracted first. The Discord bridge and runtime adapter boundary are still under active design.
