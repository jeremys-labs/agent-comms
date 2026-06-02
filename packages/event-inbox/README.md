# @agent-comms/event-inbox

Durable event inbox for external events that should wake or route to a local agent.

The package owns the reusable comms-layer pieces:

- SQLite-backed event storage and owner-scoped lifecycle.
- GitHub webhook signature verification and event normalization.
- Home Assistant webhook token verification and event normalization.
- Runtime prompt formatting for delivering an event to the owning agent.

Host applications, such as `mcc-tmux`, own HTTP route mounting and runtime injection.
