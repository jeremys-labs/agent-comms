import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DiscordGatewayClient,
  computeReconnectDelayMs,
  isFatalGatewayCloseCode,
  parseGatewayPayload,
} from './discord-gateway-client.js';

describe('parseGatewayPayload', () => {
  it('parses a valid gateway payload', () => {
    expect(parseGatewayPayload('{"op":11}')).toEqual({ op: 11 });
  });

  it('returns null instead of throwing on malformed JSON (C1)', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(parseGatewayPayload('this is not json')).toBeNull();
    spy.mockRestore();
  });
});

describe('isFatalGatewayCloseCode', () => {
  it('flags authentication/intent close codes as fatal (M2)', () => {
    for (const code of [4004, 4010, 4013, 4014]) {
      expect(isFatalGatewayCloseCode(code)).toBe(true);
    }
  });

  it('treats transient close codes as non-fatal', () => {
    for (const code of [1000, 1006, 4000, undefined]) {
      expect(isFatalGatewayCloseCode(code)).toBe(false);
    }
  });
});

describe('computeReconnectDelayMs', () => {
  it('grows the ceiling exponentially and honors the cap (L2)', () => {
    const base = 1000;
    const max = 30000;
    for (const attempt of [1, 2, 3, 5, 10]) {
      const delay = computeReconnectDelayMs(attempt, base, max);
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThanOrEqual(max);
    }
    // With jitter disabled the first attempt sits at half the base ceiling.
    const samples = Array.from({ length: 50 }, () => computeReconnectDelayMs(1, base, max));
    expect(Math.min(...samples)).toBeGreaterThanOrEqual(base / 2);
    expect(Math.max(...samples)).toBeLessThanOrEqual(base);
  });
});

describe('DiscordGatewayClient crash hardening', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not propagate a throwing onMessageCreate callback (C1)', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const client = new DiscordGatewayClient('token', () => {
      throw new Error('agent fs write failed');
    });

    expect(() => (client as any).handlePayload({ op: 0, t: 'MESSAGE_CREATE', d: { id: 'm1' } })).not.toThrow();
    client.close();
  });

  it('stops reconnecting after a fatal close code (M2)', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const client = new DiscordGatewayClient('token', () => {});

    (client as any).handleClose(4004);

    expect((client as any).shouldReconnect).toBe(false);
    expect((client as any).reconnectTimer).toBeNull();
    client.close();
  });

  it('force-reconnects a zombie socket that missed its heartbeat ACK (M4)', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const terminate = vi.fn();
    const send = vi.fn();
    const client = new DiscordGatewayClient('token', () => {});
    (client as any).ws = { terminate, send, close: vi.fn(), readyState: 1 };

    // First tick after an ACK sends normally.
    (client as any).heartbeatAcked = true;
    (client as any).sendHeartbeat();
    expect(send).toHaveBeenCalledTimes(1);
    expect(terminate).not.toHaveBeenCalled();

    // Next tick with no intervening ACK detects the zombie and terminates.
    (client as any).sendHeartbeat();
    expect(terminate).toHaveBeenCalledTimes(1);

    client.close();
  });
});
