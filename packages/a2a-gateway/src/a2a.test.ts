import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAgentMailStore, type AgentMailStore } from '@agent-comms/mailbox';
import { buildAgentCard, extractMessageText, handleA2ARequest } from './a2a.js';
import { loadA2AGatewayConfig } from './config.js';
import { A2ATaskStore } from './store.js';

describe('a2a gateway', () => {
  let tmpDir: string;
  let mailStore: AgentMailStore;
  let taskStore: A2ATaskStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-gateway-'));
    mailStore = createAgentMailStore(path.join(tmpDir, 'mail', 'agent_mail.db'));
    taskStore = new A2ATaskStore(path.join(tmpDir, 'a2a'));
  });

  afterEach(() => {
    mailStore.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('builds stable agent cards with runtime-independent URLs', () => {
    const config = loadA2AGatewayConfig({ A2A_GATEWAY_BASE_URL: 'https://agents.example.test' });
    const card = buildAgentCard(config, config.agents[0]!);

    expect(card.name).toBe('Zara');
    expect(card.url).toBe('https://agents.example.test/a2a/zara');
    expect(card.capabilities).toMatchObject({ streaming: false });
  });

  it('extracts text from A2A message parts', () => {
    expect(extractMessageText({
      message: {
        parts: [
          { kind: 'text', text: 'first' },
          { kind: 'text', text: 'second' },
        ],
      },
    })).toBe('first\nsecond');
  });

  it('persists message/send into agent-mail and task store', () => {
    const config = loadA2AGatewayConfig({ A2A_GATEWAY_BASE_URL: 'https://agents.example.test' });
    const response = handleA2ARequest('zara', {
      jsonrpc: '2.0',
      id: 'req-1',
      method: 'message/send',
      params: {
        metadata: { remoteAgent: 'tom-agent' },
        message: { parts: [{ kind: 'text', text: 'Check FrontDesk health.' }] },
      },
    }, { config, mailStore, taskStore });

    expect(response.error).toBeUndefined();
    const result = response.result as { id: string; metadata: { agentMailMessageId: string } };
    const task = taskStore.get(result.id);
    expect(task?.agentKey).toBe('zara');
    expect(task?.state).toBe('submitted');
    const inbox = mailStore.listInbox({ agent: 'zara', status: 'new' });
    expect(inbox).toHaveLength(1);
    expect(inbox[0]?.fromAgent).toBe('a2a:tom-agent');
    expect(inbox[0]?.bodyMd).toContain('Check FrontDesk health.');
  });

  it('returns tasks/get status for submitted tasks', () => {
    const config = loadA2AGatewayConfig({ A2A_GATEWAY_BASE_URL: 'https://agents.example.test' });
    const sent = handleA2ARequest('hercule', {
      jsonrpc: '2.0',
      id: 'req-1',
      method: 'message/send',
      params: { message: { parts: [{ kind: 'text', text: 'Review inference.' }] } },
    }, { config, mailStore, taskStore });
    const taskId = (sent.result as { id: string }).id;

    const got = handleA2ARequest('hercule', {
      jsonrpc: '2.0',
      id: 'req-2',
      method: 'tasks/get',
      params: { id: taskId },
    }, { config, mailStore, taskStore });

    expect(got.result).toMatchObject({
      id: taskId,
      status: { state: 'submitted' },
    });
  });

  it('surfaces local agent-mail replies as completed A2A tasks', () => {
    const config = loadA2AGatewayConfig({ A2A_GATEWAY_BASE_URL: 'https://agents.example.test' });
    const sent = handleA2ARequest('isla', {
      jsonrpc: '2.0',
      id: 'req-1',
      method: 'message/send',
      params: {
        metadata: { remoteAgent: 'tom-coordinator' },
        message: { parts: [{ kind: 'text', text: 'Summarize status.' }] },
      },
    }, { config, mailStore, taskStore });
    const result = sent.result as { id: string; metadata: { agentMailMessageId: string } };

    mailStore.reply({
      actorAgent: 'isla',
      messageId: result.metadata.agentMailMessageId,
      bodyMd: 'Status is green.',
    });

    const got = handleA2ARequest('isla', {
      jsonrpc: '2.0',
      id: 'req-2',
      method: 'tasks/get',
      params: { id: result.id },
    }, { config, mailStore, taskStore });

    expect(got.result).toMatchObject({
      id: result.id,
      status: {
        state: 'completed',
        message: { parts: [{ text: 'Status is green.' }] },
      },
    });
    expect(taskStore.get(result.id)?.state).toBe('completed');
  });
});
