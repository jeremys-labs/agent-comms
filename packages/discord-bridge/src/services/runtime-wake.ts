import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const DEFAULT_AGENTS_ROOT = '/Volumes/Repo-Drive/agents';
const DEFAULT_TMUX_SESSION = 'agents';

export interface RuntimeWakeResult {
  attempted: boolean;
  ok: boolean;
  reason?: string;
  target?: string;
}

function readRuntime(agentKey: string, agentsRoot: string): string {
  try {
    return fs.readFileSync(path.join(agentsRoot, agentKey, '.runtime'), 'utf8').trim();
  } catch {
    return '';
  }
}

export function wakeAgentRuntime(agentKey: string, input: {
  agentsRoot?: string;
  tmuxSession?: string;
  tmuxCommand?: string;
  env?: NodeJS.ProcessEnv;
} = {}): RuntimeWakeResult {
  const env = input.env ?? process.env;
  if (env.DISCORD_BRIDGE_RUNTIME_WAKE_DISABLED === '1') {
    return { attempted: false, ok: true, reason: 'disabled' };
  }

  const agentsRoot = input.agentsRoot ?? env.AGENTS_ROOT ?? DEFAULT_AGENTS_ROOT;
  const runtime = readRuntime(agentKey, agentsRoot);
  if (runtime !== 'codex') {
    return { attempted: false, ok: true, reason: runtime ? `runtime=${runtime}` : 'runtime=unknown' };
  }

  const tmuxSession = input.tmuxSession ?? env.TMUX_SESSION ?? DEFAULT_TMUX_SESSION;
  const target = `${tmuxSession}:${agentKey}`;
  const tmuxCommand = input.tmuxCommand ?? env.TMUX_COMMAND ?? 'tmux';
  try {
    execFileSync(tmuxCommand, ['send-keys', '-t', target, 'Enter'], { stdio: 'ignore' });
    return { attempted: true, ok: true, target };
  } catch (error) {
    return { attempted: true, ok: false, target, reason: String(error) };
  }
}
