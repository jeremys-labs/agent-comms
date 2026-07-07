# @agent-comms/event-inbox

> **STATUS — NOT YET WIRED (2026-07-07).** This package is not live: it has no
> production callers. Nothing populates `req.rawBody` for the webhook router, so
> mounting it as-is would 500 every webhook before signature verification, and
> no runtime imports the store. Wiring it in (rawBody middleware + route mount +
> store instantiation) vs. removing it is a pending product decision — see
> harness-review finding 06 (`agent_docs/projects/harness-review/06-ledger-inbox-a2a.md`,
> "Live-wiring status"). The storage-layer hardening in that finding has been
> applied; the dead-path decision has not been made here.

Durable event inbox for external events that should wake or route to a local agent.

The package owns the reusable comms-layer pieces:

- SQLite-backed event storage and owner-scoped lifecycle.
- GitHub webhook signature verification and event normalization.
- Home Assistant webhook token verification and event normalization.
- Runtime prompt formatting for delivering an event to the owning agent.

Host applications, such as `mcc-tmux`, own HTTP route mounting and runtime injection.
