#!/usr/bin/env bash
set -euo pipefail

ENV_FILE="${A2A_GATEWAY_ENV_FILE:-/Users/jeremylahners/.agent-comms/a2a-gateway/env}"
OP_AGENTS="/Volumes/Repo-Drive/agents/SHARED/skills/1password/scripts/op-agents"
A2A_GATEWAY_TOKEN_REF="${A2A_GATEWAY_TOKEN_REF:-op://Agents/pxgouylvcfsexogan4gngzcn6e/password}"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

export HOME="${HOME:-/Users/jeremylahners}"
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"
export AGENT_MAIL_DIR="${AGENT_MAIL_DIR:-/Volumes/Repo-Drive/agents/SHARED/agent-mail}"
export A2A_GATEWAY_HOST="${A2A_GATEWAY_HOST:-127.0.0.1}"
export A2A_GATEWAY_PORT="${A2A_GATEWAY_PORT:-4378}"
export A2A_GATEWAY_STATE_DIR="${A2A_GATEWAY_STATE_DIR:-/Users/jeremylahners/.agent-comms/a2a-gateway}"
export A2A_GATEWAY_AGENTS="${A2A_GATEWAY_AGENTS:-zara,hercule,isla}"

# The gateway credential is managed in 1Password. Never inherit a plaintext
# copy from the legacy env file; op-agents injects it only into the gateway
# process and fails closed before exec if retrieval is unavailable.
unset A2A_GATEWAY_BEARER_TOKEN

cd /Volumes/Repo-Drive/src/agent-comms
exec "$OP_AGENTS" run \
  "A2A_GATEWAY_BEARER_TOKEN=$A2A_GATEWAY_TOKEN_REF" \
  -- npm run gateway --workspace=@agent-comms/a2a-gateway
