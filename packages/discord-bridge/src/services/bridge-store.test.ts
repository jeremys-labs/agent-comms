import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendInboxEntry, hasSeen, markSeen, readBridgeState } from './bridge-store.js';

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
});
