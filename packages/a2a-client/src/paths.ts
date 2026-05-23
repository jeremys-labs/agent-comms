import os from 'node:os';
import path from 'node:path';

const DEFAULT_ROOT = path.join(os.homedir(), '.tmux-mcc');

/**
 * Centralized path resolver so the CLI, lib, and tests agree on locations.
 * Override the root with the `MCC_TMUX_HOME` env var (for tests).
 */
export interface A2APaths {
  root: string;
  a2aDir: string;
  peersFile: string;
  pendingFile: string;
  auditFile: string;
  secretsDir: string;
}

export function resolveA2APaths(envHome?: string): A2APaths {
  const root = envHome ?? process.env['MCC_TMUX_HOME'] ?? DEFAULT_ROOT;
  return {
    root,
    a2aDir: path.join(root, 'a2a'),
    peersFile: path.join(root, 'a2a', 'peers.json'),
    pendingFile: path.join(root, 'a2a', 'pending.jsonl'),
    auditFile: path.join(root, 'a2a', 'audit.jsonl'),
    secretsDir: path.join(root, 'secrets'),
  };
}

export function defaultTokenFile(peerKey: string, paths: A2APaths = resolveA2APaths()): string {
  return path.join(paths.secretsDir, `a2a-${peerKey}.token`);
}
