#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { sendDiscordViaBridge } from './outbound-client.js';

type Args = {
  agent?: string;
  chatId?: string;
  text?: string;
  textFile?: string;
  files: string[];
  socketPath?: string;
  source?: string;
  jobId?: string;
  label?: string;
};

function usage(): never {
  console.error('Usage: agent-discord-send --agent <agent> --chat-id <id> (--text <text> | --text-file <absolute-path>) [--file <absolute-path> ...]');
  process.exit(2);
}

function parseArgs(argv: string[]): Args {
  const parsed: Args = { files: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    const next = argv[index + 1];
    if (item === '--agent') parsed.agent = next;
    else if (item === '--chat-id') parsed.chatId = next;
    else if (item === '--text') parsed.text = next;
    else if (item === '--text-file') parsed.textFile = next;
    else if (item === '--file' && next) parsed.files.push(next);
    else if (item === '--socket-path') parsed.socketPath = next;
    else if (item === '--source') parsed.source = next;
    else if (item === '--job-id') parsed.jobId = next;
    else if (item === '--label') parsed.label = next;
    else usage();
    index += 1;
  }
  return parsed;
}

const args = parseArgs(process.argv.slice(2));
if (!args.agent || !args.chatId) usage();
if (args.textFile) {
  if (!path.isAbsolute(args.textFile)) usage();
  args.text = fs.readFileSync(args.textFile, 'utf8');
}
for (const file of args.files) {
  if (!path.isAbsolute(file)) usage();
}
if (!args.text && args.files.length === 0) usage();

const result = await sendDiscordViaBridge({
  agentKey: args.agent,
  chat_id: args.chatId,
  text: args.text,
  files: args.files,
  source: args.source ?? process.env.SCHEDULED_DISCORD_SOURCE,
  job_id: args.jobId ?? process.env.SCHEDULED_JOB_ID,
  label: args.label ?? process.env.SCHEDULED_JOB_LABEL,
}, { socketPath: args.socketPath });
console.log(JSON.stringify(result));

