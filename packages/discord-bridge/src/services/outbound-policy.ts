import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const OUTBOUND_CLASSES = [
  'interactive_reply',
  'scheduled_digest',
  'alert',
  'system_monitor',
] as const;

export type OutboundClass = typeof OUTBOUND_CLASSES[number];

export type OutboundPolicy = {
  channelId: string;
  outboundClass: OutboundClass;
  maxChars?: number;
  label?: string;
};

export type OutboundPolicyRegistry = {
  version: 1;
  policies: OutboundPolicy[];
};

export type OutboundPolicyState =
  | { ok: true; registry: OutboundPolicyRegistry }
  | { ok: false; error: string };

export type OutboundOverride = {
  reason: string;
};

export type OutboundViolation = {
  ruleId: string;
  message: string;
  repair: string;
};

export type OutboundPolicyDenial = {
  allowed: false;
  statusCode: number;
  body: {
    error: 'outbound_policy_denied';
    ruleIds: string[];
    violations: OutboundViolation[];
    repair: string;
    limitation: string;
  };
};

export type OutboundPolicyDecision =
  | { allowed: true; overridden: boolean }
  | OutboundPolicyDenial;

export type OverrideAuditRecord = {
  timestamp: string;
  agentKey: string;
  channelId: string;
  outboundClass: OutboundClass;
  reason: string;
  ruleIds: string[];
};

const LIMITATION = 'This catches mechanically recognizable jargon, shape and length. It cannot catch plain English that still assumes context Jeremy doesn\'t have.';

const JARGON_RULES: Array<{ ruleId: string; pattern: RegExp; message: string; repair: string }> = [
  {
    ruleId: 'eli5.uuid',
    pattern: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i,
    message: 'The message includes an internal job or run identifier.',
    repair: 'Name what the job does for Jeremy instead of using its identifier.',
  },
  {
    ruleId: 'eli5.ledger_id',
    pattern: /\bdc-\d{8}-\d{3}\b/i,
    message: 'The message includes an internal commitment-row identifier.',
    repair: 'Describe the commitment in plain English instead of using its row number.',
  },
  {
    ruleId: 'eli5.file_path',
    pattern: /(?<![\w/.])(?:\/Volumes\/|\/Users\/|~\/\.)[\w./~-]+/i,
    message: 'The message includes an internal file path.',
    repair: 'Name the document or system in plain English and omit its storage path.',
  },
  {
    ruleId: 'eli5.file_name',
    pattern: /(?<![\w/])[\w.-]+\.(?:py|sh|ts|tsx|jsonl|mjs)\b/i,
    message: 'The message includes an internal script or file name.',
    repair: 'Explain what the script or file does for Jeremy instead of naming it.',
  },
  {
    ruleId: 'eli5.scheduler_internal',
    pattern: /\bcron\b|\bcrontab\b|\bjobs\.json\b|\b\.fired-keys\b/i,
    message: 'The message includes scheduler jargon.',
    repair: 'Describe when the task should run and what it does, without scheduler vocabulary.',
  },
  {
    ruleId: 'eli5.internal_tool',
    pattern: /\bagent-mail\b/i,
    message: 'The message includes an internal tool name.',
    repair: 'Describe the human-visible handoff or outcome instead of naming the tool.',
  },
];

export function defaultOutboundPolicyPath(): string {
  return fileURLToPath(new URL('../../config/outbound-policy.json', import.meta.url));
}

export function isOutboundClass(value: unknown): value is OutboundClass {
  return typeof value === 'string' && OUTBOUND_CLASSES.includes(value as OutboundClass);
}

function parseRegistry(value: unknown): OutboundPolicyRegistry {
  if (!value || typeof value !== 'object') throw new Error('registry must be an object');
  const candidate = value as { version?: unknown; policies?: unknown };
  if (candidate.version !== 1) throw new Error('registry version must be 1');
  if (!Array.isArray(candidate.policies)) throw new Error('registry policies must be an array');

  const seen = new Set<string>();
  const policies = candidate.policies.map((raw, index): OutboundPolicy => {
    if (!raw || typeof raw !== 'object') throw new Error(`policy ${index} must be an object`);
    const policy = raw as Record<string, unknown>;
    if (typeof policy.channelId !== 'string' || !/^\d+$/.test(policy.channelId)) {
      throw new Error(`policy ${index} channelId must be a Discord channel id`);
    }
    if (!isOutboundClass(policy.outboundClass)) {
      throw new Error(`policy ${index} has an invalid outboundClass`);
    }
    if (policy.maxChars !== undefined && (!Number.isInteger(policy.maxChars) || Number(policy.maxChars) <= 0)) {
      throw new Error(`policy ${index} maxChars must be a positive integer`);
    }
    const key = `${policy.channelId}:${policy.outboundClass}`;
    if (seen.has(key)) throw new Error(`duplicate policy ${key}`);
    seen.add(key);
    return {
      channelId: policy.channelId,
      outboundClass: policy.outboundClass,
      ...(policy.maxChars === undefined ? {} : { maxChars: Number(policy.maxChars) }),
      ...(typeof policy.label === 'string' ? { label: policy.label } : {}),
    };
  });
  return { version: 1, policies };
}

export function loadOutboundPolicyRegistry(
  filePath = process.env.DISCORD_BRIDGE_OUTBOUND_POLICY ?? defaultOutboundPolicyPath(),
): OutboundPolicyState {
  try {
    return { ok: true, registry: parseRegistry(JSON.parse(fs.readFileSync(filePath, 'utf8'))) };
  } catch (error) {
    return { ok: false, error: `cannot load outbound policy ${filePath}: ${String(error)}` };
  }
}

function deny(statusCode: number, violations: OutboundViolation[]): OutboundPolicyDenial {
  return {
    allowed: false,
    statusCode,
    body: {
      error: 'outbound_policy_denied',
      ruleIds: violations.map((violation) => violation.ruleId),
      violations,
      repair: 'Rewrite the message in plain English: name the thing, explain why it matters to Jeremy, and end with one action or “nothing needed.”',
      limitation: LIMITATION,
    },
  };
}

export function inspectInteractiveReply(text: string, maxChars?: number): OutboundViolation[] {
  const violations: OutboundViolation[] = [];
  if (maxChars !== undefined && text.length > maxChars) {
    violations.push({
      ruleId: 'eli5.length',
      message: `The message is ${text.length} characters; this channel allows ${maxChars}.`,
      repair: `Shorten the complete reply to ${maxChars} characters or fewer before it is split for delivery.`,
    });
  }

  const lines = text.split(/\r?\n/);
  const documentHeaders = lines.filter((line) => (
    /^\s*#{1,6}\s+\S/.test(line)
    || /^\s*\*\*[^*]{2,60}\*\*\s*:?\s*$/.test(line)
    || /^\s*\d+\.\s+\*\*[^*]+\*\*/.test(line)
  ));
  const bullets = lines.filter((line) => /^\s*[-*•]\s+\S/.test(line));
  const boldSpans = text.match(/\*\*[^*]+\*\*/g) ?? [];
  if (documentHeaders.length > 0 || bullets.length > 4 || boldSpans.length > 3) {
    violations.push({
      ruleId: 'eli5.document_shape',
      message: 'The reply is formatted like a document instead of a conversational message.',
      repair: 'Remove section headings and excess bullets or bolding; send the finding, why it matters, and one action.',
    });
  }

  const withoutUrls = text.replace(/https?:\/\/\S+/gi, ' ');
  for (const rule of JARGON_RULES) {
    if (rule.pattern.test(withoutUrls)) {
      violations.push({ ruleId: rule.ruleId, message: rule.message, repair: rule.repair });
    }
  }
  return violations;
}

export function evaluateOutboundPolicy(input: {
  state: OutboundPolicyState;
  agentKey: string;
  channelId: string;
  outboundClass: OutboundClass;
  text: string;
  override?: OutboundOverride;
  auditOverride?: (record: OverrideAuditRecord) => void;
}): OutboundPolicyDecision {
  if (!input.state.ok) {
    if (input.outboundClass !== 'interactive_reply') return { allowed: true, overridden: false };
    return deny(503, [{
      ruleId: 'eli5.policy_unavailable',
      message: 'The interactive-message policy could not be loaded, so delivery failed closed.',
      repair: 'Restore the policy registry before retrying this interactive reply.',
    }]);
  }

  const policy = input.state.registry.policies.find((candidate) => (
    candidate.channelId === input.channelId && candidate.outboundClass === input.outboundClass
  ));
  if (!policy) return { allowed: true, overridden: false };

  const violations = inspectInteractiveReply(input.text, policy.maxChars);
  if (violations.length === 0) return { allowed: true, overridden: false };

  const reason = input.override?.reason?.trim();
  if (!reason || reason.length < 10) return deny(422, violations);
  if (!input.auditOverride) {
    return deny(503, [{
      ruleId: 'eli5.override_audit_unavailable',
      message: 'The override could not be audit-logged, so delivery failed closed.',
      repair: 'Restore the override audit path or send a compliant message.',
    }]);
  }
  try {
    input.auditOverride({
      timestamp: new Date().toISOString(),
      agentKey: input.agentKey,
      channelId: input.channelId,
      outboundClass: input.outboundClass,
      reason,
      ruleIds: violations.map((violation) => violation.ruleId),
    });
    return { allowed: true, overridden: true };
  } catch {
    return deny(503, [{
      ruleId: 'eli5.override_audit_failed',
      message: 'The override audit write failed, so delivery failed closed.',
      repair: 'Restore the override audit path or send a compliant message.',
    }]);
  }
}

export function appendOverrideAudit(contentRoot: string, record: OverrideAuditRecord): void {
  const auditPath = path.join(contentRoot, 'bridge', 'outbound-policy-overrides.jsonl');
  fs.mkdirSync(path.dirname(auditPath), { recursive: true });
  fs.appendFileSync(auditPath, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
}
