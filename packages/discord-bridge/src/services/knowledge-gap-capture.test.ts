import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { captureKnowledgeGapReply } from './knowledge-gap-capture.js';
import type { DiscordBridgeInboxEntry } from '../types/bridge.js';

const baseEntry: DiscordBridgeInboxEntry = {
  id: '1508000000000000000',
  agentKey: 'isla',
  channelId: '1493425484036309092',
  author: 'kingclueless_',
  authorId: '1030632000756920371',
  content: 'I grew up in Lincoln and weekends were always busy.',
  timestamp: '2026-05-24T17:15:00.000Z',
};

describe('knowledge gap capture', () => {
  let tmpDir: string;
  let logPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-gap-'));
    logPath = path.join(tmpDir, 'isla', 'memory', 'knowledge_gap_log.md');
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('fills the same-day pending answer and routing fields for Jeremy in hq', () => {
    fs.writeFileSync(logPath, [
      '# Knowledge Gap Question Log',
      '',
      '## 2026-05-24',
      '- **Question:** What was Lincoln like?',
      '- **Source:** self-generated',
      '- **Topic:** childhood',
      '- **Answer:** _pending_',
      '- **Routing:** _pending_',
      '',
    ].join('\n'));

    const result = captureKnowledgeGapReply(baseEntry, { agentsRoot: tmpDir });

    expect(result).toEqual({ captured: true, reason: 'captured' });
    const updated = fs.readFileSync(logPath, 'utf8');
    expect(updated).toContain('- **Answer:** I grew up in Lincoln and weekends were always busy.');
    expect(updated).toContain('Captured from #hq Discord message 1508000000000000000');
    expect(updated).toContain('- **Routing:** Auto-captured by knowledge-gap reply loop.');
  });

  it('does not fill a question logged as failed delivery', () => {
    fs.writeFileSync(logPath, [
      '# Knowledge Gap Question Log',
      '',
      '## 2026-05-24',
      '- **Question:** What was Lincoln like?',
      '- **Send status:** FAILED - permission mode blocked delivery.',
      '- **Answer:** _pending_',
      '- **Routing:** _pending_',
      '',
    ].join('\n'));

    const result = captureKnowledgeGapReply(baseEntry, { agentsRoot: tmpDir });

    expect(result).toEqual({ captured: false, reason: 'question-not-delivered' });
    expect(fs.readFileSync(logPath, 'utf8')).toContain('- **Answer:** _pending_');
  });

  it('requires a referenced question match when the log has a Discord message id', () => {
    fs.writeFileSync(logPath, [
      '# Knowledge Gap Question Log',
      '',
      '## 2026-05-24',
      '- **Question:** What was Lincoln like?',
      '- **Discord message id:** 111',
      '- **Answer:** _pending_',
      '- **Routing:** _pending_',
      '',
    ].join('\n'));

    const result = captureKnowledgeGapReply({
      ...baseEntry,
      referencedMessageId: '222',
    }, { agentsRoot: tmpDir });

    expect(result).toEqual({ captured: false, reason: 'referenced-message-mismatch' });
    expect(fs.readFileSync(logPath, 'utf8')).toContain('- **Answer:** _pending_');
  });
});

