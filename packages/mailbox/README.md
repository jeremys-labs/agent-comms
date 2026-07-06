# @agent-comms/mailbox

Durable local mailbox for coordinating multiple agents.

The package provides:

- a SQLite-backed mailbox store
- threaded messages through correlation IDs
- message lifecycle operations: send, ack, reply, close
- coordination search across message subjects, bodies, and metadata
- a CLI exposed as `agent-mail`
- prompt formatting helpers for runtime injection

## Status

Pre-1.0. Expect breaking changes while the package is extracted and hardened.

## Storage

By default, the mailbox database is stored at:

```text
~/.agent-comms/mailbox/agent_mail.db
```

Override with:

```bash
AGENT_MAIL_DIR=/path/to/mailbox agent-mail inbox --agent marcus
```

## CLI

```bash
agent-mail send \
  --from eli \
  --to marcus \
  --type question \
  --subject "Need API owner" \
  --body "Who owns the next API cut?" \
  --requires-response

agent-mail inbox --agent marcus --status new
agent-mail ack --agent marcus --id msg_123
agent-mail reply --agent marcus --id msg_123 --body "I own it."
agent-mail close --agent marcus --id msg_123
agent-mail search --query "knowledge-gap pending" --agent eli --limit 10 --json
agent-mail audit-required --older-than-minutes 60 [--from eli] [--to marcus] [--fail-on-overdue]
```

`search` matches all query terms across id, correlation id, sender, recipient,
subject, body, project, and status. Results default newest-first with `--limit
20`. Passing `--agent` scopes results to messages that agent sent or received;
omitting it follows the current mailbox model and searches the fleet-open store.
Use `--json` for machine-readable output.

`audit-required` reports required-response messages that crossed the age
threshold without a reply. It distinguishes unacknowledged delivery,
acknowledged-but-unanswered work, and threads closed without a response.
Acknowledgement alone is not treated as completion. `--fail-on-overdue` sets
exit code 2 for health checks and scheduled audits.
