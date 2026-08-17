import { execFileSync, spawnSync } from 'child_process';
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
