import { execFileSync, spawnSync } from 'child_process';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

const cliPath = fileURLToPath(new URL('./cli.ts', import.meta.url));

function runCli(args: string[]): { stdout: string; status: number } {
  const env = { ...process.env };
  delete env.AGENT_MAIL_DIR;
  delete env.AGENT_MAIL_ALLOW_DEFAULT;
  const stdout = execFileSync(process.execPath, ['--import', 'tsx', cliPath, ...args], {
    encoding: 'utf8',
    env,
  });
  return { stdout, status: 0 };
}

describe('agent-mail CLI help', () => {
  // Regression: --help lands in the command position; help must resolve before
  // the store is opened so an unset AGENT_MAIL_DIR does not turn into an error.
  it('prints usage for --help with AGENT_MAIL_DIR unset and exits 0', () => {
    const { stdout, status } = runCli(['--help']);
    expect(status).toBe(0);
    expect(stdout).toContain('Usage: agent-mail');
  });

  it('prints usage for -h, help, and no args', () => {
    expect(runCli(['-h']).stdout).toContain('Usage: agent-mail');
    expect(runCli(['help']).stdout).toContain('Usage: agent-mail');
    expect(runCli([]).stdout).toContain('Usage: agent-mail');
  });
});

describe('agent-mail CLI handoffs', () => {
  it('persists machine alerts through the real CLI contract', () => {
    const mailDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-mail-cli-'));
    try {
      const result = spawnSync(
        process.execPath,
        ['--import', 'tsx', cliPath, 'send', '--from', 'isla', '--to', 'isla', '--type', 'alert', '--priority', 'high', '--subject', 'Delivery FAILED: planted', '--body', 'Planted failure.'],
        { encoding: 'utf8', env: { ...process.env, AGENT_MAIL_DIR: mailDir } },
      );
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('"type": "alert"');
      expect(result.stdout).toContain('"priority": "high"');
    } finally {
      fs.rmSync(mailDir, { recursive: true, force: true });
    }
  });

  it('allows self-addressed loop mail; runtime wake suppression owns containment', () => {
    const mailDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-mail-cli-'));
    try {
      const result = spawnSync(
        process.execPath,
        ['--import', 'tsx', cliPath, 'send', '--from', 'isla', '--to', 'isla', '--type', 'note', '--subject', 'Loop kickoff', '--body', 'Continue the loop.'],
        { encoding: 'utf8', env: { ...process.env, AGENT_MAIL_DIR: mailDir } },
      );
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('"fromAgent": "isla"');
      expect(result.stdout).toContain('"toAgent": "isla"');
    } finally {
      fs.rmSync(mailDir, { recursive: true, force: true });
    }
  });

  it('rejects a handoff that omits required fields', () => {
    const mailDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-mail-cli-'));
    try {
      const result = spawnSync(
        process.execPath,
        ['--import', 'tsx', cliPath, 'send', '--from', 'eli', '--to', 'marcus', '--type', 'handoff', '--subject', 'Review', '--body', 'Owner: Eli'],
        { encoding: 'utf8', env: { ...process.env, AGENT_MAIL_DIR: mailDir } },
      );
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('Handoff requires non-empty fields: next-action, artifact, verification-status.');
    } finally {
      fs.rmSync(mailDir, { recursive: true, force: true });
    }
  });
});

describe('agent-mail CLI enforces the agent-time rule at the transport', () => {
  // The rule only ran as a Claude PreToolUse Bash hook, so Codex turns and MCP
  // tools bypassed it entirely. Enforced in readBody(), the single function both
  // `send` and `reply` use to obtain a body, so a future subcommand cannot get one
  // unchecked. These drive the REAL CLI, not the helper.
  function send(mailDir: string, body: string, extra: string[] = [], env: Record<string, string> = {}) {
    return spawnSync(
      process.execPath,
      ['--import', 'tsx', cliPath, 'send', '--from', 'marcus', '--to', 'isla',
       '--type', 'note', '--subject', 's', '--body', body, ...extra],
      { encoding: 'utf8', env: { ...process.env, AGENT_MAIL_DIR: mailDir, ...env } },
    );
  }

  it('blocks a body that defers work, through the real send path', () => {
    const mailDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-mail-dg-'));
    const journal = path.join(mailDir, 'j.jsonl');
    try {
      const r = send(mailDir, 'I will ship the fix tomorrow.', [], { DEFERRAL_GUARD_JOURNAL: journal });
      // Exit 2 specifically: a POLICY REFUSAL, distinct from exit 1 for a usage
      // error. It also must not arrive as an uncaught exception -- a stack trace
      // reads as a broken tool rather than as a refusal.
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('agent-time rule');
      expect(r.stderr).not.toContain('at readBody');
      expect(r.stderr).not.toContain('Error:');
      // journalled with its own kind, so a run of these is visible
      const events = fs.readFileSync(journal, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      expect(events.some((e) => e.kind === 'block' && e.source === 'agent-mail-cli')).toBe(true);
    } finally {
      fs.rmSync(mailDir, { recursive: true, force: true });
    }
  });

  it('permits a clean body', () => {
    const mailDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-mail-dg-'));
    try {
      const r = send(mailDir, 'Done, took about 20 minutes.', [], {
        DEFERRAL_GUARD_JOURNAL: path.join(mailDir, 'j.jsonl'),
      });
      expect(r.status).toBe(0);
    } finally {
      fs.rmSync(mailDir, { recursive: true, force: true });
    }
  });

  it('--waits-on permits the send and records the blocker as METADATA, not in the body', () => {
    const mailDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-mail-dg-'));
    try {
      const body = 'I will ship the fix tomorrow.';
      const r = send(mailDir, body, ['--waits-on', "jeremy's approval on the rollout"], {
        DEFERRAL_GUARD_JOURNAL: path.join(mailDir, 'j.jsonl'),
      });
      expect(r.status).toBe(0);
      // the body reaches the recipient UNCHANGED -- the justification is not appended
      expect(JSON.parse(r.stdout).bodyMd).toBe(body);
      // Asserted against the EVENTS table, which is where the metadata lives.
      // My first version asserted on `thread` output, which prints messages and
      // not events -- so it was reading the wrong surface and failed while the
      // code was correct. The event row is the thing the requirement names.
      const id = JSON.parse(r.stdout).id as string;
      const db = new Database(path.join(mailDir, 'agent_mail.db'), { readonly: true });
      try {
        const rows = db
          .prepare('SELECT event_type, payload_json FROM message_events WHERE message_id = ?')
          .all(id) as Array<{ event_type: string; payload_json: string | null }>;
        const waits = rows.find((row) => row.event_type === 'waits_on');
        expect(waits).toBeDefined();
        expect(JSON.parse(waits!.payload_json!).blocker).toBe("jeremy's approval on the rollout");
      } finally {
        db.close();
      }
    } finally {
      fs.rmSync(mailDir, { recursive: true, force: true });
    }
  });

  it('FAILS OPEN and journals when the checker cannot run', () => {
    // isla's decision: mail must not depend on the guard being healthy. But the
    // fail-open is recorded with its own kind, because a broken checker must not
    // look like a quiet, compliant fleet.
    const mailDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-mail-dg-'));
    const journal = path.join(mailDir, 'j.jsonl');
    try {
      const r = send(mailDir, 'I will ship the fix tomorrow.', [], {
        DEFERRAL_CHECK: path.join(mailDir, 'no-such-checker.py'),
        DEFERRAL_GUARD_JOURNAL: journal,
      });
      expect(r.status).toBe(0);                       // permitted
      expect(r.stderr).toContain('NOT CHECKED');      // and loud
      const events = fs.readFileSync(journal, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      expect(events.some((e) => e.kind === 'fail-open')).toBe(true);
    } finally {
      fs.rmSync(mailDir, { recursive: true, force: true });
    }
  });
});
