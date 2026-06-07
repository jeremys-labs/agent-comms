# @agent-comms/outbound-router

Runtime-neutral governed outbound delivery.

The router owns canonical outbound envelopes, policy checks, adapter routing,
retry behavior, and idempotency. Channel adapters own transport-specific API
calls. Callers do not bypass policy by invoking Discord, BlueBubbles, or future
channel APIs directly.
