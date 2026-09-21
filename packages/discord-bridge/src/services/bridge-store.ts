import fs from 'fs';
import path from 'path';
import type { DiscordBridgeInboxEntry } from '../types/bridge.js';

export interface BridgeState {
  /** Cursor used as the Discord REST `after` parameter. Most recent id per subscription. */
  lastSeenMessageIds: Record<string, string>;
  /**
   * Every message id we have actually delivered, per subscription (bounded ring).
   * The cursor alone cannot answer "have I delivered this?" — only "was this the
   * most recent one?" — so a message the cursor has moved past was re-delivered
   * whenever a concurrent backfill was still holding an older cursor.
   */
  seenMessageIds: Record<string, string[]>;
}

const MAX_SEEN_IDS_PER_SUBSCRIPTION = 500;

function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

function statePath(contentRoot: string): string {
  return path.join(contentRoot, 'bridge', 'state.json');
}

function inboxDir(contentRoot: string): string {
  return path.join(contentRoot, 'bridge', 'inbox');
}

export function readBridgeState(contentRoot: string): BridgeState {
  const filePath = statePath(contentRoot);
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<BridgeState>;
    return {
      lastSeenMessageIds: parsed.lastSeenMessageIds ?? {},
      seenMessageIds: parsed.seenMessageIds ?? {},
    };
  } catch {
    return { lastSeenMessageIds: {}, seenMessageIds: {} };
  }
}

export function markSeen(contentRoot: string, subscriptionKey: string, messageId: string): void {
  ensureDir(path.dirname(statePath(contentRoot)));
  const current = readBridgeState(contentRoot);
  current.lastSeenMessageIds[subscriptionKey] = messageId;

  const seen = current.seenMessageIds[subscriptionKey] ?? [];
  if (!seen.includes(messageId)) {
    seen.push(messageId);
    if (seen.length > MAX_SEEN_IDS_PER_SUBSCRIPTION) {
      seen.splice(0, seen.length - MAX_SEEN_IDS_PER_SUBSCRIPTION);
    }
  }
  current.seenMessageIds[subscriptionKey] = seen;

  const target = statePath(contentRoot);
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(current, null, 2));
  fs.renameSync(tmp, target);
}

export function getLastSeen(contentRoot: string, subscriptionKey: string): string | undefined {
  return readBridgeState(contentRoot).lastSeenMessageIds[subscriptionKey];
}

export function hasSeen(contentRoot: string, subscriptionKey: string, messageId: string): boolean {
  const current = readBridgeState(contentRoot);
  if (current.lastSeenMessageIds[subscriptionKey] === messageId) return true;
  return (current.seenMessageIds[subscriptionKey] ?? []).includes(messageId);
}

export function appendInboxEntry(contentRoot: string, entry: DiscordBridgeInboxEntry): string {
  ensureDir(inboxDir(contentRoot));
  const filePath = path.join(inboxDir(contentRoot), `${entry.agentKey}.jsonl`);
  fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`);
  return filePath;
}
