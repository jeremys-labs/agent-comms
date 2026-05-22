#!/usr/bin/env bash
set -euo pipefail

ENV_FILE="${A2A_GATEWAY_ENV_FILE:-/Users/jeremylahners/.agent-comms/a2a-gateway/env}"

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

cd /Volumes/Repo-Drive/src/agent-comms
exec npm run gateway --workspace=@agent-comms/a2a-gateway
