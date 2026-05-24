import fs from 'fs';
import path from 'path';
import type { DiscordBridgeInboxEntry } from '../types/bridge.js';

const DEFAULT_AGENTS_ROOT = '/Volumes/Repo-Drive/agents';
const ISLA_AGENT = 'isla';
const HQ_CHANNEL_ID = '1493425484036309092';
const JEREMY_USER_ID = '1030632000756920371';

export interface KnowledgeGapCaptureOptions {
  agentsRoot?: string;
}

export interface KnowledgeGapCaptureResult {
  captured: boolean;
  reason: string;
}

function knowledgeGapLogPath(agentsRoot: string): string {
  return path.join(agentsRoot, ISLA_AGENT, 'memory', 'knowledge_gap_log.md');
}

function etDateFromIso(iso: string): string {
  const date = new Date(iso);
  const safeDate = Number.isNaN(date.getTime()) ? new Date() : date;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(safeDate);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function formatEtTimestamp(iso: string): string {
  const date = new Date(iso);
  const safeDate = Number.isNaN(date.getTime()) ? new Date() : date;
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZoneName: 'short',
  }).format(safeDate);
}

function compactMarkdownLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function findSection(text: string, dateKey: string): { start: number; end: number; body: string } | null {
  const header = `## ${dateKey}`;
  const start = text.indexOf(header);
  if (start === -1) return null;
  const next = text.indexOf('\n## ', start + header.length);
  const end = next === -1 ? text.length : next;
  return { start, end, body: text.slice(start, end) };
}

function sectionHasFailedDelivery(section: string): boolean {
  return /Send status:\*\*\s*FAILED/i.test(section)
    || /Question never delivered/i.test(section)
    || /Delivery:\*\*\s*FAILED/i.test(section);
}

function referencedQuestionMatches(section: string, entry: DiscordBridgeInboxEntry): boolean {
  const match = section.match(/Discord message id:\*\*\s*([0-9]+)/i)
    ?? section.match(/Discord message ID:\*\*\s*([0-9]+)/i);
  if (!match) return true;
  return entry.referencedMessageId === match[1];
}

function replaceOrAppendField(section: string, field: 'Answer' | 'Routing', value: string): string {
  const pattern = new RegExp(`- \\*\\*${field}:\\*\\*.*`);
  if (pattern.test(section)) {
    return section.replace(pattern, `- **${field}:** ${value}`);
  }
  return `${section.trimEnd()}\n- **${field}:** ${value}\n`;
}

export function captureKnowledgeGapReply(
  entry: DiscordBridgeInboxEntry,
  options: KnowledgeGapCaptureOptions = {},
): KnowledgeGapCaptureResult {
  if (entry.agentKey !== ISLA_AGENT) return { captured: false, reason: 'not-isla' };
  if (entry.channelId !== HQ_CHANNEL_ID) return { captured: false, reason: 'not-hq' };
  if (entry.authorId !== JEREMY_USER_ID) return { captured: false, reason: 'not-jeremy' };
  if (!entry.content.trim()) return { captured: false, reason: 'empty-message' };

  const agentsRoot = options.agentsRoot ?? DEFAULT_AGENTS_ROOT;
  const filePath = knowledgeGapLogPath(agentsRoot);
  if (!fs.existsSync(filePath)) return { captured: false, reason: 'log-missing' };

  const log = fs.readFileSync(filePath, 'utf8');
  const dateKey = etDateFromIso(entry.timestamp);
  const section = findSection(log, dateKey);
  if (!section) return { captured: false, reason: 'section-missing' };
  if (!/- \*\*Answer:\*\*\s*_pending_/i.test(section.body)) {
    return { captured: false, reason: 'answer-not-pending' };
  }
  if (sectionHasFailedDelivery(section.body)) {
    return { captured: false, reason: 'question-not-delivered' };
  }
  if (!referencedQuestionMatches(section.body, entry)) {
    return { captured: false, reason: 'referenced-message-mismatch' };
  }

  const answer = `${compactMarkdownLine(entry.content)} (Captured from #hq Discord message ${entry.id}, ${formatEtTimestamp(entry.timestamp)}.)`;
  const routing = 'Auto-captured by knowledge-gap reply loop. Profile/routing review pending; append durable facts to SHARED/JEREMY-PROFILE.md if substantive.';
  let updatedSection = replaceOrAppendField(section.body, 'Answer', answer);
  updatedSection = replaceOrAppendField(updatedSection, 'Routing', routing);
  const updatedLog = `${log.slice(0, section.start)}${updatedSection}${log.slice(section.end)}`;
  fs.writeFileSync(filePath, updatedLog);
  return { captured: true, reason: 'captured' };
}

