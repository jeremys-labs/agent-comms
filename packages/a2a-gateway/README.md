# Agent A2A Gateway

Minimal Agent2Agent gateway for exposing local agents to external agent teams.

This package intentionally treats A2A as an external boundary. Inbound A2A
tasks are converted into durable local `agent-mail` messages so the current
runtime can be Claude, Codex, or another implementation without changing the
public agent card.

Initial exposed agents:

- `zara` - FrontDesk, voice bridge, and repository operations
- `hercule` - forensic_ai implementation, tests, and review
- `isla` - coordination, status synthesis, and triage

## Run

```bash
A2A_GATEWAY_BEARER_TOKEN=change-me \
AGENT_MAIL_DIR=/Volumes/Repo-Drive/agents/SHARED/agent-mail \
npm run gateway --workspace=@agent-comms/a2a-gateway
```

For launchd, write secrets and public URL to:

```text
/Users/jeremylahners/.agent-comms/a2a-gateway/env
```

Then load:

```bash
cp deploy/launchd/com.jeremylahners.agent-comms-a2a-gateway.plist \
  ~/Library/LaunchAgents/
launchctl bootstrap "gui/$(id -u)" \
  ~/Library/LaunchAgents/com.jeremylahners.agent-comms-a2a-gateway.plist
```

Useful environment:

- `A2A_GATEWAY_HOST` defaults to `127.0.0.1`
- `A2A_GATEWAY_PORT` defaults to `4378`
- `A2A_GATEWAY_BASE_URL` overrides the public URL published in agent cards
- `A2A_GATEWAY_BEARER_TOKEN` enables bearer auth on JSON-RPC task endpoints
- `A2A_GATEWAY_AGENTS=zara,hercule,isla` filters the exposed agent list
- `A2A_GATEWAY_STATE_DIR` stores the gateway task JSONL log

## Endpoints

- `GET /.well-known/agents.json`
- `GET /agents/:agent/.well-known/agent-card.json`
- `POST /a2a/:agent`

Supported JSON-RPC methods:

- `message/send` - creates a local `agent-mail` message for the target agent
- `tasks/get` - returns submitted status, or completed status once the target
  agent replies to the generated `agent-mail` thread

This first slice is polling-only: no streaming and no push notifications.

## Open Brain Capture

The gateway logs A2A conversations to OB1 using each target agent's
`.open-brain/memory.env` key:

- inbound external tasks are captured as `raw_capture` with `project=external-a2a`
- local agent replies are captured as `private_agent` context with
  `project=external-a2a`

Capture is non-blocking. A failed OB1 write is logged to stderr but does not
reject the A2A request.
