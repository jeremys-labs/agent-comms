#!/usr/bin/env node
import http from 'http';
import { buildAgentCard, findAgent, handleA2ARequest } from './a2a.js';
import { loadA2AGatewayConfig } from './config.js';
import { createOpenBrainA2ALogger } from './open-brain.js';
import type { JsonRpcRequest } from './types.js';

const config = loadA2AGatewayConfig();
const conversationLogger = createOpenBrainA2ALogger();

function json(res: http.ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function authorized(req: http.IncomingMessage): boolean {
  if (!config.bearerToken) return true;
  return req.headers.authorization === `Bearer ${config.bearerToken}`;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error('request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const cardMatch = url.pathname.match(/^\/agents\/([^/]+)\/\.well-known\/agent-card\.json$/);
    if (req.method === 'GET' && cardMatch) {
      const agentKey = decodeURIComponent(cardMatch[1]!);
      const agent = findAgent(config, agentKey);
      if (!agent) return json(res, 404, { error: `Unknown agent: ${agentKey}` });
      return json(res, 200, buildAgentCard(config, agent));
    }

    if (req.method === 'GET' && url.pathname === '/.well-known/agents.json') {
      return json(res, 200, {
        agents: config.agents.map((agent) => ({
          key: agent.key,
          cardUrl: `${config.baseUrl}/agents/${encodeURIComponent(agent.key)}/.well-known/agent-card.json`,
        })),
      });
    }

    const rpcMatch = url.pathname.match(/^\/a2a\/([^/]+)$/);
    if (req.method === 'POST' && rpcMatch) {
      if (!authorized(req)) return json(res, 401, { error: 'Unauthorized' });
      const agentKey = decodeURIComponent(rpcMatch[1]!);
      const request = JSON.parse(await readBody(req)) as JsonRpcRequest;
      return json(res, 200, handleA2ARequest(agentKey, request, { config, conversationLogger }));
    }

    return json(res, 404, { error: 'Not found' });
  } catch (error) {
    return json(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(config.port, config.host, () => {
  console.log(`[a2a-gateway] listening on http://${config.host}:${config.port}`);
  for (const agent of config.agents) {
    console.log(`[a2a-gateway] ${agent.key} card: ${config.baseUrl}/agents/${agent.key}/.well-known/agent-card.json`);
  }
});
