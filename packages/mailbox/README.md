# @agent-comms/mailbox

Durable local mailbox for coordinating multiple agents.

The package provides:

- a SQLite-backed mailbox store
- threaded messages through correlation IDs
- message lifecycle operations: send, ack, reply, close
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
```

# Branch review handoffs

Generate Git-backed evidence for a branch-review handoff before sending it:

```bash
agent-mail branch-manifest \
  --repo /path/to/repo \
  --base origin/main \
  --branch my/branch \
  --test-command "npm test" \
  --output /tmp/branch-handoff.md
```

Attach the output to the fleet's five-field handoff. Keep owner, status/blocker,
next action, and source-of-truth status in the handoff prose because those are
human claims. The generated artifact contains only evidence: `git cherry` scope,
per-commit files, diffstat, a mandatory activation/default scan, and the actual
test command with its observed exit code/output. It records failing tests rather
than hiding them. The activation/default scan surfaces candidate changed lines
for human judgment; it does not interpret their runtime semantics.
