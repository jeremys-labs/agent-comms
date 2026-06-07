export type OutboundChannel = 'discord' | 'bluebubbles' | string;

export interface OutboundEnvelope {
  id: string;
  channel: OutboundChannel;
  fromAgent: string;
  destination: string;
  text?: string;
  files?: string[];
  replyTo?: string;
  metadata?: Record<string, unknown>;
}

export interface OutboundDeliveryResult {
  envelopeId: string;
  channel: OutboundChannel;
  destination: string;
  transportMessageId?: string;
  attempts: number;
  duplicate: boolean;
}

export interface OutboundPolicyDecision {
  allowed: boolean;
  reason: string;
}

export interface OutboundChannelAdapter {
  channel: OutboundChannel;
  deliver(envelope: OutboundEnvelope): Promise<{ transportMessageId?: string }>;
}

export interface OutboundRouterOptions {
  adapters: OutboundChannelAdapter[];
  authorize(envelope: OutboundEnvelope): Promise<OutboundPolicyDecision> | OutboundPolicyDecision;
  maxAttempts?: number;
  retryDelayMs?: number;
}

export class OutboundPolicyRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OutboundPolicyRefusedError';
  }
}

function validateEnvelope(envelope: OutboundEnvelope): void {
  if (!envelope.id || !envelope.fromAgent || !envelope.channel || !envelope.destination) {
    throw new Error('id, fromAgent, channel, and destination are required');
  }
  if (!envelope.text?.trim() && (envelope.files?.length ?? 0) === 0) {
    throw new Error('text or files are required');
  }
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function createOutboundRouter(options: OutboundRouterOptions) {
  const adapters = new Map(options.adapters.map((adapter) => [adapter.channel, adapter]));
  const deliveries = new Map<string, Promise<OutboundDeliveryResult>>();
  const maxAttempts = options.maxAttempts ?? 3;
  const retryDelayMs = options.retryDelayMs ?? 100;

  return async (envelope: OutboundEnvelope): Promise<OutboundDeliveryResult> => {
    validateEnvelope(envelope);
    const existing = deliveries.get(envelope.id);
    if (existing) return { ...await existing, duplicate: true };

    const delivery = (async (): Promise<OutboundDeliveryResult> => {
      const decision = await options.authorize(envelope);
      if (!decision.allowed) throw new OutboundPolicyRefusedError(decision.reason);
      const adapter = adapters.get(envelope.channel);
      if (!adapter) throw new Error(`no outbound adapter registered for ${envelope.channel}`);

      let lastError: unknown;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          const result = await adapter.deliver(envelope);
          return {
            envelopeId: envelope.id,
            channel: envelope.channel,
            destination: envelope.destination,
            transportMessageId: result.transportMessageId,
            attempts: attempt,
            duplicate: false,
          };
        } catch (error) {
          lastError = error;
          if (attempt < maxAttempts) await wait(retryDelayMs);
        }
      }
      throw lastError;
    })();
    deliveries.set(envelope.id, delivery);
    try {
      return await delivery;
    } catch (error) {
      deliveries.delete(envelope.id);
      throw error;
    }
  };
}
