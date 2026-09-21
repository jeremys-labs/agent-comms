import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendInboxEntry, getLastSeen, hasSeen, markSeen, readBridgeState } from './bridge-store.js';

describe('discord bridge store', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-bridge-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('appends an inbox entry for an agent', () => {
    const filePath = appendInboxEntry(tmpDir, {
      id: 'm1',
      agentKey: 'marcus',
      channelId: 'c1',
      author: 'Jeremy',
      content: 'hello',
      attachments: [{
        url: 'https://cdn.discordapp.com/attachments/message.txt',
        filename: 'message.txt',
        content_type: 'text/plain',
        size: 12,
      }],
      timestamp: '2026-04-13T18:00:00.000Z',
    });

    const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.agentKey).toBe('marcus');
    expect(parsed.attachments).toEqual([{
      url: 'https://cdn.discordapp.com/attachments/message.txt',
      filename: 'message.txt',
      content_type: 'text/plain',
      size: 12,
    }]);
  });

  it('tracks last seen message IDs', () => {
    expect(hasSeen(tmpDir, 'marcus:c1', 'm1')).toBe(false);
    markSeen(tmpDir, 'marcus:c1', 'm1');
    expect(hasSeen(tmpDir, 'marcus:c1', 'm1')).toBe(true);
    expect(readBridgeState(tmpDir).lastSeenMessageIds['marcus:c1']).toBe('m1');
  });

  it('writes state atomically without leaving a temp file behind (L1)', () => {
    markSeen(tmpDir, 'marcus:c1', 'm1');
    const bridgeDir = path.join(tmpDir, 'bridge');
    const leftovers = fs.readdirSync(bridgeDir).filter((name) => name.startsWith('state.json') && name !== 'state.json');
    expect(leftovers).toEqual([]);
    expect(readBridgeState(tmpDir).lastSeenMessageIds['marcus:c1']).toBe('m1');
  });

  it('still recognises a message after a later message is marked seen (duplicate-inbound defect)', () => {
    markSeen(tmpDir, 'marcus:c1', 'm1');
    markSeen(tmpDir, 'marcus:c1', 'm2');

    // m2 advanced the cursor, but m1 was genuinely delivered and must never be re-delivered.
    expect(hasSeen(tmpDir, 'marcus:c1', 'm1')).toBe(true);
    expect(hasSeen(tmpDir, 'marcus:c1', 'm2')).toBe(true);
  });

  it('keeps the last-seen cursor pointing at the most recent message', () => {
    markSeen(tmpDir, 'marcus:c1', 'm1');
    markSeen(tmpDir, 'marcus:c1', 'm2');

    expect(getLastSeen(tmpDir, 'marcus:c1')).toBe('m2');
  });

  it('bounds how many seen ids it retains per subscription', () => {
    for (let i = 0; i < 600; i += 1) markSeen(tmpDir, 'marcus:c1', `m${i}`);

    const retained = readBridgeState(tmpDir).seenMessageIds?.['marcus:c1'] ?? [];
    expect(retained.length).toBeGreaterThan(1);
    expect(retained.length).toBeLessThanOrEqual(500);
    expect(hasSeen(tmpDir, 'marcus:c1', 'm599')).toBe(true);
    expect(hasSeen(tmpDir, 'marcus:c1', 'm598')).toBe(true);
  });

  it('does not leak seen ids across subscriptions', () => {
    markSeen(tmpDir, 'marcus:c1', 'm1');

    expect(hasSeen(tmpDir, 'isla:c1', 'm1')).toBe(false);
  });
});
