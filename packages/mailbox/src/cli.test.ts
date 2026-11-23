import { execFileSync, spawnSync } from 'child_process';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { resolveJournal, resolveJournalRoute } from './cli.js';
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

describe('journal routing (shared case table)', () => {
  // THE SAME TABLE THE PYTHON SUITE READS. isla's requirement on dc-20261123-006: a
  // hand-copied arm list across two languages drifts exactly the way the four inlined send
  // regexes in guard-message-body.py did, and that drift is only found when it matters. So
  // neither side carries its own list -- both read
  // SHARED/hooks/journal-routing-cases.json.
  //
  // hercule's rule (msg_6961be83): divert ONLY on an explicit positive marker; ANY
  // ambiguity goes to the LIVE report. A dropped block is evidence that never existed.
  const CASES_FILE =
    '/Volumes/Repo-Drive/agents/SHARED/hooks/journal-routing-cases.json';

  type Case = { name: string; env: Record<string, string>; expect: string; why: string };

  const table = JSON.parse(fs.readFileSync(CASES_FILE, 'utf8')) as { cases: Case[] };

  // A temp reports dir, so a routing mistake in this suite can never reach the real
  // files. The Python suite does the same; the table's {REPORTS} placeholder is what lets
  // one table serve both.
  const REPORTS = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-journal-routing-'));

  function expected(c: Case): string {
    const sub = (v: string) => v.replace(/\{REPORTS\}/g, REPORTS);
    if (c.expect === 'live') return `${REPORTS}/deferral-guard.jsonl`;
    if (c.expect === 'fixtures') return `${REPORTS}/deferral-guard.test-fixtures.jsonl`;
    return sub(c.expect);
  }

  it('the shared table is non-empty and carries both verdicts', () => {
    // Without this, a table that failed to load would make every case below vacuous and
    // the suite would pass by running nothing.
    expect(table.cases.length).toBeGreaterThan(5);
    expect(table.cases.some((c) => c.expect === 'live')).toBe(true);
    expect(table.cases.some((c) => c.expect === 'fixtures')).toBe(true);
  });

  it('every shared case pins a route string', () => {
    // Without this, a table missing `why` would make the vocabulary assertions below
    // compare undefined to undefined and pass by checking nothing.
    for (const c of table.cases) {
      expect(typeof c.why).toBe('string');
      expect(c.why.length).toBeGreaterThan(0);
    }
  });

  it.each(table.cases.map((c) => [c.name, c] as [string, Case]))(
    'stamps the same journal_route as Python: %s',
    (_name, c) => {
      // hercule's acceptance criterion on the stamp: the field AND the vocabulary must
      // match Python, or isla's one-line quarantine filter still cannot see TS rows and
      // the hole has moved rather than closed. The expected strings in the table were
      // GENERATED from deferral_check.resolve_journal, not hand-typed.
      const saved = { ...process.env };
      try {
        for (const k of ['DEFERRAL_GUARD_JOURNAL', 'DEFERRAL_GUARD_PROBE']) {
          delete process.env[k];
        }
        process.env.DEFERRAL_GUARD_REPORTS_DIR = REPORTS;
        for (const [k, v] of Object.entries(c.env)) {
          process.env[k] = v.replace(/\{REPORTS\}/g, REPORTS);
        }
        expect(resolveJournalRoute().why).toBe(c.why);
      } finally {
        for (const k of Object.keys(process.env)) delete process.env[k];
        Object.assign(process.env, saved);
      }
    },
  );

  it('a WRITTEN row carries journal_route, not just the resolver', () => {
    // Asserting resolveJournalRoute().why is NOT the same claim as asserting the writer
    // stamps it. hercule's criterion is that TS WRITES journal_route on every route, so
    // this drives the real CLI and reads the row off disk.
    const mailDir = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-route-write-'));
    const journal = path.join(mailDir, 'j.jsonl');
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', cliPath, 'send', '--from', 'marcus', '--to', 'isla',
       '--type', 'note', '--subject', 's', '--body', 'I will ship it tomorrow.'],
      {
        encoding: 'utf8',
        env: { ...process.env, AGENT_MAIL_DIR: mailDir, DEFERRAL_GUARD_JOURNAL: journal },
      },
    );
    expect(result.status).not.toBe(0);
    const rows = fs
      .readFileSync(journal, 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      // Byte-equal to what Python stamps for an explicit path -- the cross-path
      // quarantine filter depends on the vocabulary matching, not just the field existing.
      expect(row.journal_route).toBe('explicit DEFERRAL_GUARD_JOURNAL');
    }
  });

  it.each(table.cases.map((c) => [c.name, c] as [string, Case]))(
    'resolves: %s',
    (_name, c) => {
      const saved = { ...process.env };
      try {
        for (const k of ['DEFERRAL_GUARD_JOURNAL', 'DEFERRAL_GUARD_PROBE']) {
          delete process.env[k];
        }
        process.env.DEFERRAL_GUARD_REPORTS_DIR = REPORTS;
        for (const [k, v] of Object.entries(c.env)) {
          process.env[k] = v.replace(/\{REPORTS\}/g, REPORTS);
        }
        expect(resolveJournal()).toBe(expected(c));
      } finally {
        for (const k of Object.keys(process.env)) delete process.env[k];
        Object.assign(process.env, saved);
      }
    },
  );
});

describe('agent-mail CLI reply authorization', () => {
  function cli(mailDir: string, args: string[]) {
    return spawnSync(
      process.execPath,
      ['--import', 'tsx', cliPath, ...args],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          AGENT_MAIL_DIR: mailDir,
          // A CONTROL RUN MUST NOT REACH A LIVE DESTINATION. Without this, the helper
          // inherits cli.ts's hardcoded default and any journalling send through it
          // appends to SHARED/reports/deferral-guard.jsonl -- the live fleet report.
          //
          // It was safe only BY CONTENT, not by construction: this helper's bodies are
          // the literal string 'body', which does not defer, so nothing journalled. The
          // next test added here with a deferring body, or any fail-open on this path,
          // would have written to the live file. isla cleaned 122 fixture rows out of
          // that report on 2026-11-23 and this was its last open path.
          DEFERRAL_GUARD_JOURNAL: path.join(mailDir, 'deferral-guard.jsonl'),
        },
      },
    );
  }

  function send(mailDir: string, from: string, to: string) {
    const result = cli(mailDir, [
      'send', '--from', from, '--to', to, '--type', 'note',
      '--subject', 'reply authorization', '--body', 'body',
    ]);
    expect(result.status).toBe(0);
    return JSON.parse(result.stdout) as { id: string; correlationId: string };
  }

  it('cli() journals to a per-test path, never the live fleet report', () => {
    // isla's condition on the fix. Two assertions, because "it no longer pollutes" and
    // "nothing journalled at all" look identical: the per-test journal must GROW, and the
    // path the helper would otherwise have inherited must stay EMPTY.
    //
    // DELIBERATELY HERMETIC: my first version asserted the real
    // SHARED/reports/deferral-guard.jsonl did not change size. That is RACY BY
    // CONSTRUCTION -- other agents write that file continuously, and it grew 217 -> 228
    // from real traffic while I was writing this test. An assertion about a live shared
    // file is a flake waiting to be blamed on the code under test. So the inherited
    // default is redirected to a sentinel this test owns, and the claim becomes exactly
    // "the helper overrides what it inherits".
    const sizeOf = (p: string) => (fs.existsSync(p) ? fs.statSync(p).size : 0);
    const mailDir = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-isolation-'));
    const perTest = path.join(mailDir, 'deferral-guard.jsonl');
    const sentinel = path.join(mailDir, 'inherited-sentinel.jsonl');
    const previous = process.env.DEFERRAL_GUARD_JOURNAL;
    process.env.DEFERRAL_GUARD_JOURNAL = sentinel;

    // A body that DEFERS, so the guard journals a block event. The helper's own sends use
    // a non-deferring body, which is why this hazard was invisible.
    const result = cli(mailDir, [
      'send', '--from', 'marcus', '--to', 'isla', '--type', 'note',
      '--subject', 's', '--body', 'I will ship the fix tomorrow.',
    ]);

    if (previous === undefined) delete process.env.DEFERRAL_GUARD_JOURNAL;
    else process.env.DEFERRAL_GUARD_JOURNAL = previous;

    expect(result.status).not.toBe(0);
    expect(sizeOf(perTest)).toBeGreaterThan(0);
    expect(sizeOf(sentinel)).toBe(0);
  });

  function counts(mailDir: string) {
    const db = new Database(path.join(mailDir, 'agent_mail.db'), { readonly: true });
    try {
      return {
        messages: (db.prepare('SELECT count(*) AS n FROM messages').get() as { n: number }).n,
        events: (db.prepare('SELECT count(*) AS n FROM message_events').get() as { n: number }).n,
      };
    } finally {
      db.close();
    }
  }

  it('allows recipient and self-note replies through the real CLI', () => {
    const mailDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-mail-cli-reply-auth-'));
    try {
      const ordinary = send(mailDir, 'isla', 'hercule');
      const ordinaryReply = cli(mailDir, [
        'reply', '--agent', 'hercule', '--id', ordinary.id, '--body', 'ordinary reply',
      ]);
      expect(ordinaryReply.status).toBe(0);
      expect(JSON.parse(ordinaryReply.stdout).toAgent).toBe('isla');

      const selfNote = send(mailDir, 'isla', 'isla');
      const selfReply = cli(mailDir, [
        'reply', '--agent', 'isla', '--id', selfNote.id, '--body', 'self reply',
      ]);
      expect(selfReply.status).toBe(0);
      expect(JSON.parse(selfReply.stdout).toAgent).toBe('isla');
    } finally {
      fs.rmSync(mailDir, { recursive: true, force: true });
    }
  });

  it.each([
    ['the original sender', 'isla'],
    ['a third party', 'remy'],
  ])('refuses %s through the real CLI without changing row counts', (_label, actorAgent) => {
    const mailDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-mail-cli-reply-auth-'));
    try {
      const original = send(mailDir, 'isla', 'hercule');
      const before = counts(mailDir);
      const result = cli(mailDir, [
        'reply', '--agent', actorAgent, '--id', original.id, '--body', 'injected',
      ]);
      // Exit 3 SPECIFICALLY, and not merely non-zero. A refusal is a completed
      // operation that said no, so it must be distinguishable by a scripting
      // caller from exit 1 (usage / any other failure) and from exit 2 (the
      // agent-time rule). `not.toBe(0)` passed happily while this was an
      // uncaught throw, which is why it is not the assertion.
      expect(result.status).toBe(3);
      expect(result.stderr).toContain(
        `you are not a recipient of ${original.id}; use send --to <agent>`,
      );
      // The instruction is the FIRST thing on screen, not buried under frames.
      expect(result.stderr.trimStart().startsWith('REFUSED:')).toBe(true);
      // No stack trace: a trace reads as "the tool broke" rather than as a
      // refusal. These fail if anyone reverts it to a thrown Error.
      expect(result.stderr).not.toContain('AgentMailRefusal:');
      expect(result.stderr).not.toContain('at reply');
      expect(result.stderr).not.toMatch(/^\s+at /m);
      expect(counts(mailDir)).toEqual(before);
    } finally {
      fs.rmSync(mailDir, { recursive: true, force: true });
    }
  });

  it('keeps a declared CLI send to self as exactly one message', () => {
    const mailDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-mail-cli-reply-auth-'));
    try {
      send(mailDir, 'isla', 'isla');
      expect(counts(mailDir)).toEqual({ messages: 1, events: 1 });
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
