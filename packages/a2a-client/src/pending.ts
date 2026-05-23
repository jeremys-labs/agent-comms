import fs from 'node:fs';
import path from 'node:path';
import { resolveA2APaths, type A2APaths } from './paths.js';
import type { A2APendingTaskRow } from './types.js';

/**
 * Append a single pending row. Marcus's poller in mcc-tmux consumes this file
 * and rewrites it without terminal rows.
 */
export function appendPendingRow(row: A2APendingTaskRow, paths: A2APaths = resolveA2APaths()): void {
  fs.mkdirSync(path.dirname(paths.pendingFile), { recursive: true });
  fs.appendFileSync(paths.pendingFile, `${JSON.stringify(row)}\n`, { encoding: 'utf8' });
}

export function readPendingRows(paths: A2APaths = resolveA2APaths()): A2APendingTaskRow[] {
  if (!fs.existsSync(paths.pendingFile)) return [];
  return fs
    .readFileSync(paths.pendingFile, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as A2APendingTaskRow);
}

const DEFAULT_EXPIRY_MS = 30 * 60 * 1000;

export function expiryFromSentAt(sentAt: string, ms: number = DEFAULT_EXPIRY_MS): string {
  return new Date(new Date(sentAt).getTime() + ms).toISOString();
}
