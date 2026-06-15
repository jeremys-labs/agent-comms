import http from 'node:http';

export interface DiscordBridgeOutboundRequest {
  agentKey: string;
  chat_id: string;
  text?: string;
  files?: string[];
  reply_to?: string;
  source?: string;
  job_id?: string;
  label?: string;
  awaiting_reply?: boolean;
}

export interface DiscordBridgeSendResult {
  ok: true;
  id: string;
  bindingName: string;
}

export interface DiscordBridgeSendOptions {
  socketPath?: string;
}

export function sendDiscordViaBridge(
  request: DiscordBridgeOutboundRequest,
  options: DiscordBridgeSendOptions = {},
): Promise<DiscordBridgeSendResult> {
  const socketPath = options.socketPath
    ?? process.env.DISCORD_BRIDGE_SOCKET_PATH
    ?? '/tmp/agent-discord-bridge.sock';
  if (!request.agentKey || !request.chat_id || (!request.text && (request.files?.length ?? 0) === 0)) {
    return Promise.reject(new Error('agentKey, chat_id, and text or files are required'));
  }

  const payload = JSON.stringify(request);
  return new Promise((resolve, reject) => {
    const req = http.request({
      socketPath,
      path: '/send',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        const status = res.statusCode ?? 500;
        if (status < 200 || status >= 300) {
          reject(new Error(`Discord bridge send failed ${status}: ${body}`));
          return;
        }
        try {
          resolve(JSON.parse(body) as DiscordBridgeSendResult);
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}
