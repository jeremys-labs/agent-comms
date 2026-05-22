import type { A2AGatewayAgent, A2AGatewayConfig } from './types.js';

export const DEFAULT_A2A_AGENTS: A2AGatewayAgent[] = [
  {
    key: 'zara',
    name: 'Zara',
    description: 'FrontDesk, voice bridge, and repository operations agent.',
    skills: [
      {
        id: 'frontdesk-ops',
        name: 'FrontDesk operations',
        description: 'Review FrontDesk issues, repository state, voice bridge status, and deployment tasks.',
        tags: ['frontdesk', 'voice-bridge', 'repo-ops'],
      },
    ],
  },
  {
    key: 'hercule',
    name: 'Hercule',
    description: 'Inference and forensic_ai implementation, testing, and review agent.',
    skills: [
      {
        id: 'forensic-ai',
        name: 'forensic_ai engineering',
        description: 'Handle forensic_ai code review, implementation, tests, ingest pipeline, and API/Lambda tasks.',
        tags: ['forensic_ai', 'inference', 'testing'],
      },
    ],
  },
  {
    key: 'isla',
    name: 'Isla',
    description: 'Coordination, project triage, and cross-agent status synthesis agent.',
    skills: [
      {
        id: 'coordination',
        name: 'Coordination and status synthesis',
        description: 'Coordinate local agents, summarize status, triage work, and route follow-up tasks.',
        tags: ['coordination', 'status', 'triage'],
      },
    ],
  },
];

export function loadA2AGatewayConfig(env: NodeJS.ProcessEnv = process.env): A2AGatewayConfig {
  const port = Number(env.A2A_GATEWAY_PORT ?? 4378);
  const host = env.A2A_GATEWAY_HOST ?? '127.0.0.1';
  const baseUrl = env.A2A_GATEWAY_BASE_URL ?? `http://${host}:${port}`;
  const agentFilter = env.A2A_GATEWAY_AGENTS
    ? new Set(env.A2A_GATEWAY_AGENTS.split(',').map((agent) => agent.trim()).filter(Boolean))
    : null;
  return {
    baseUrl: baseUrl.replace(/\/$/, ''),
    host,
    port,
    bearerToken: env.A2A_GATEWAY_BEARER_TOKEN,
    agents: agentFilter
      ? DEFAULT_A2A_AGENTS.filter((agent) => agentFilter.has(agent.key))
      : DEFAULT_A2A_AGENTS,
  };
}

