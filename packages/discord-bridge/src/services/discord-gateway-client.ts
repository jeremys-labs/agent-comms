import WebSocket from 'ws';
import type { DiscordMessageEvent } from '../types/bridge.js';

const GATEWAY_URL = 'wss://gateway.discord.gg/?v=10&encoding=json';
const INTENTS =
  1 +      // GUILDS
  512 +    // GUILD_MESSAGES
  4096 +   // DIRECT_MESSAGES
  32768;   // MESSAGE_CONTENT

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;

// Fatal gateway close codes: authentication failed / invalid intents. Retrying
// these just spams IDENTIFY from the shared IP, so we stop reconnecting.
export const FATAL_GATEWAY_CLOSE_CODES = new Set([4004, 4010, 4013, 4014]);

interface GatewayPayload {
  op: number;
  t?: string;
  s?: number | null;
  d?: any;
}

export function parseGatewayPayload(raw: string): GatewayPayload | null {
  try {
    return JSON.parse(raw) as GatewayPayload;
  } catch (error) {
    console.error('[discord-bridge] dropping malformed gateway payload:', error);
    return null;
  }
}

export function isFatalGatewayCloseCode(code: number | undefined): boolean {
  return code !== undefined && FATAL_GATEWAY_CLOSE_CODES.has(code);
}

/**
 * Jittered exponential backoff for reconnects. The ceiling doubles per attempt
 * (capped at maxMs); the returned delay is a random point in the upper half of
 * that ceiling so 12 bots don't thundering-herd IDENTIFY after a blip.
 */
export function computeReconnectDelayMs(attempt: number, baseMs = RECONNECT_BASE_MS, maxMs = RECONNECT_MAX_MS): number {
  const exponent = Math.max(0, attempt - 1);
  const ceiling = Math.min(maxMs, baseMs * 2 ** exponent);
  return Math.round(ceiling / 2 + Math.random() * (ceiling / 2));
}

export class DiscordGatewayClient {
  private ws: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private seq: number | null = null;
  private shouldReconnect = true;
  private reconnectAttempts = 0;
  private heartbeatAcked = true;
  private selfUserIdValue: string | undefined;

  /** The bot's own user id, learned from the gateway READY payload. */
  get selfUserId(): string | undefined {
    return this.selfUserIdValue;
  }

  constructor(
    private readonly token: string,
    private readonly onMessageCreate: (event: DiscordMessageEvent) => void,
  ) {}

  connect(): void {
    this.clearReconnectTimer();
    const localAddress = process.env.DISCORD_BRIDGE_LOCAL_ADDRESS;
    this.ws = new WebSocket(GATEWAY_URL, localAddress ? { localAddress } : undefined);
    this.ws.on('message', (raw) => {
      const payload = parseGatewayPayload(raw.toString());
      if (payload) this.handlePayload(payload);
    });
    this.ws.on('close', (code) => this.handleClose(code));
    this.ws.on('error', (error) => console.error('[discord-bridge] discord gateway error:', error));
  }

  close(): void {
    this.shouldReconnect = false;
    this.clearReconnectTimer();
    this.cleanup();
    this.ws?.close();
    this.ws = null;
  }

  private handleClose(code?: number): void {
    this.cleanup();
    this.ws = null;
    if (isFatalGatewayCloseCode(code)) {
      this.shouldReconnect = false;
      this.clearReconnectTimer();
      console.error(`[discord-bridge] fatal Discord gateway close ${code} — not reconnecting (check token/intents)`);
      return;
    }
    this.scheduleReconnect();
  }

  private cleanup(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (!this.shouldReconnect || this.reconnectTimer) return;
    const delay = computeReconnectDelayMs(this.reconnectAttempts + 1);
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      console.log(`[discord-bridge] reconnecting Discord gateway (attempt ${this.reconnectAttempts})`);
      this.connect();
    }, delay);
  }

  private send(op: number, d: unknown): void {
    this.ws?.send(JSON.stringify({ op, d }));
  }

  private identify(): void {
    this.send(2, {
      token: this.token,
      intents: INTENTS,
      properties: {
        os: process.platform,
        browser: 'agent-discord-bridge',
        device: 'agent-discord-bridge',
      },
    });
  }

  private startHeartbeat(intervalMs: number): void {
    this.cleanup();
    this.heartbeatAcked = true;
    this.heartbeatTimer = setInterval(() => {
      this.sendHeartbeat();
    }, intervalMs);
  }

  private sendHeartbeat(): void {
    if (!this.heartbeatAcked) {
      // Previous heartbeat was never ACKed (op 11) — the socket is a zombie.
      console.error('[discord-bridge] missed heartbeat ACK — forcing gateway reconnect');
      this.ws?.terminate();
      return;
    }
    this.heartbeatAcked = false;
    this.send(1, this.seq);
  }

  private handlePayload(payload: GatewayPayload): void {
    if (typeof payload.s === 'number') this.seq = payload.s;

    if (payload.op === 10) {
      this.startHeartbeat(payload.d.heartbeat_interval);
      this.identify();
      return;
    }

    if (payload.op === 11) {
      this.heartbeatAcked = true;
      return;
    }

    if (payload.op === 0) {
      if (payload.t === 'READY') {
        this.reconnectAttempts = 0;
        this.selfUserIdValue = payload.d?.user?.id ?? this.selfUserIdValue;
      }
      if (payload.t === 'MESSAGE_CREATE') {
        try {
          this.onMessageCreate(payload.d as DiscordMessageEvent);
        } catch (error) {
          console.error('[discord-bridge] onMessageCreate handler threw — dropping message:', error);
        }
      }
    }
  }
}
