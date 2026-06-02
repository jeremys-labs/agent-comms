#!/usr/bin/env node
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createEventInboxStore,
  createEventWebhookRouter,
} from './index.js';

function resolveDbPath(): string {
  const explicit = process.env.AGENT_COMMS_EVENT_INBOX_DB ?? process.env.EVENT_INBOX_DB;
  if (explicit) return explicit;
  return path.join(os.homedir(), '.agent-comms', 'event-inbox.db');
}

const port = Number(process.env.AGENT_COMMS_EVENT_INBOX_PORT ?? process.env.EVENT_INBOX_PORT ?? '8091');
const dbPath = resolveDbPath();
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const eventInbox = createEventInboxStore(dbPath);
const app = express();
app.use(express.json({
  limit: process.env.AGENT_COMMS_EVENT_INBOX_JSON_LIMIT ?? '10mb',
  verify: (req, _res, buf) => {
    (req as any).rawBody = Buffer.from(buf);
  },
}));

app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'agent-event-inbox-gateway',
    timestamp: Date.now(),
  });
});
app.use('/api', createEventWebhookRouter(eventInbox));

const server = app.listen(port, () => {
  console.log(`[agent-event-inbox-gateway] listening on :${port}`);
  console.log(`[agent-event-inbox-gateway] db: ${dbPath}`);
});

function shutdown(): void {
  console.log('[agent-event-inbox-gateway] shutting down');
  eventInbox.close();
  server.close(() => process.exit(0));
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
