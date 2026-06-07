import { describe, expect, it, vi } from 'vitest';
import {
  createOutboundRouter,
  OutboundPolicyRefusedError,
  type OutboundEnvelope,
} from './index.js';

const envelope: OutboundEnvelope = {
  id: 'delivery-1',
  channel: 'bluebubbles',
  fromAgent: 'isla',
  destination: 'iMessage;-;+15551234567',
  text: 'Hello',
};

describe('outbound router', () => {
  it('authorizes and delivers an envelope idempotently', async () => {
    const deliver = vi.fn(async () => ({ transportMessageId: 'msg-1' }));
    const route = createOutboundRouter({
      authorize: () => ({ allowed: true, reason: 'allowlisted' }),
      adapters: [{ channel: 'bluebubbles', deliver }],
    });

    const first = await route(envelope);
    const duplicate = await route(envelope);

    expect(first).toMatchObject({ attempts: 1, duplicate: false, transportMessageId: 'msg-1' });
    expect(duplicate).toMatchObject({ duplicate: true, transportMessageId: 'msg-1' });
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it('refuses delivery before invoking the adapter', async () => {
    const deliver = vi.fn(async () => ({}));
    const route = createOutboundRouter({
      authorize: () => ({ allowed: false, reason: 'notify-only sender' }),
      adapters: [{ channel: 'bluebubbles', deliver }],
    });

    await expect(route(envelope)).rejects.toBeInstanceOf(OutboundPolicyRefusedError);
    expect(deliver).not.toHaveBeenCalled();
  });

  it('retries transport failures and does not cache failed delivery', async () => {
    const deliver = vi.fn()
      .mockRejectedValueOnce(new Error('temporary'))
      .mockResolvedValueOnce({ transportMessageId: 'msg-2' });
    const route = createOutboundRouter({
      authorize: () => ({ allowed: true, reason: 'allowed' }),
      adapters: [{ channel: 'bluebubbles', deliver }],
      maxAttempts: 2,
      retryDelayMs: 0,
    });

    await expect(route(envelope)).resolves.toMatchObject({ attempts: 2, transportMessageId: 'msg-2' });
  });

  it('requires text or files', async () => {
    const route = createOutboundRouter({
      authorize: () => ({ allowed: true, reason: 'allowed' }),
      adapters: [],
    });

    await expect(route({ ...envelope, text: '' })).rejects.toThrow('text or files are required');
  });
});
