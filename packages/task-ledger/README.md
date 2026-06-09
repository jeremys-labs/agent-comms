# @agent-comms/task-ledger

Shared, file-based cross-agent **task ledger** — durable work-STATE for the fleet.
Sibling to the mailbox: `agent-mail` carries coordination *messages*; this carries
the *work state* those messages are about. A task **links** to the mail thread /
Discord message that spawned it — it does not reimplement them.

## Store

One JSON file per task under `$TASK_LEDGER_DIR/tasks/<id>.json`
(default `/Volumes/Repo-Drive/agents/SHARED/task-ledger`), written atomically
(tmp + rename). Per-task files mean parallel agents writing different tasks never
contend. No daemon, no index/cache, no manager layer — `list` reads the dir and
filters in memory (fleet scale is dozens of tasks).

## CLI (P0)

```
task-ledger add    --owner X --title "..." [--created-by Y] [--priority low|med|high] [--context "..."] [--links a,b] [--tags x,y]
task-ledger update --id T [--status open|in_progress|blocked|handed_off|done|killed] [--priority ...] [--title ...] [--owner ...] [--context ...] [--blocked-on ...] [--handoff-to ...]
task-ledger list   [--owner X] [--status in_progress,blocked] [--json]
task-ledger show   --id T
task-ledger close  --id T [--outcome done|killed]
```

## Status

- **P0 (done):** data model + atomic file store + `add/update/list/show/close`, single-agent usable.
- **P1 (next):** `handoff` + `blocked_on` + `--fleet` view + handoff notification (reuse agent-mail event path). Also evaluate compare-and-swap on `updatedAt` for concurrent same-task updates (flagged, not built).
- **P2:** surfacing — Isla fleet-board command, optional newsletter line, stale-blocker escalation.

Spec: `/Volumes/Repo-Drive/agents/eli/docs/self-improvement/2026-06-09-two-lane-loop-and-task-ledger-spec.md`
