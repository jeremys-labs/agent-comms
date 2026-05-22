import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { wakeAgentRuntime } from './runtime-wake.js';

const execFileSyncMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({
  execFileSync: execFileSyncMock,
}));

describe('runtime wake', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-runtime-wake-'));
    execFileSyncMock.mockReset();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeRuntime(agent: string, runtime: string): void {
    fs.mkdirSync(path.join(tmpDir, agent), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, agent, '.runtime'), `${runtime}\n`);
  }

  it('sends Enter to the codex agent tmux window', () => {
    writeRuntime('zara', 'codex');

    const result = wakeAgentRuntime('zara', {
      agentsRoot: tmpDir,
      tmuxSession: 'agents',
      tmuxCommand: 'tmux-test',
      env: {},
    });

    expect(result).toEqual({ attempted: true, ok: true, target: 'agents:zara' });
    expect(execFileSyncMock).toHaveBeenCalledWith(
      'tmux-test',
      ['send-keys', '-t', 'agents:zara', 'Enter'],
      { stdio: 'ignore' },
    );
  });

  it('skips non-codex runtimes', () => {
    writeRuntime('isla', 'claude');

    const result = wakeAgentRuntime('isla', {
      agentsRoot: tmpDir,
      env: {},
    });

    expect(result).toEqual({ attempted: false, ok: true, reason: 'runtime=claude' });
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it('can be disabled by environment', () => {
    writeRuntime('zara', 'codex');

    const result = wakeAgentRuntime('zara', {
      agentsRoot: tmpDir,
      env: { DISCORD_BRIDGE_RUNTIME_WAKE_DISABLED: '1' },
    });

    expect(result).toEqual({ attempted: false, ok: true, reason: 'disabled' });
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });
});
