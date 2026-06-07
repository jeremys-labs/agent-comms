# @agent-comms/bluebubbles-adapter

Governed outbound BlueBubbles adapter for `@agent-comms/outbound-router`.

It reads the existing BlueBubbles state format, retains the hard `allowFrom`
outbound gate, and supports text and attachment delivery through the
BlueBubbles REST API.

This package does not change inbound policy or autonomously edit the allowlist.
