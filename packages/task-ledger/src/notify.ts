import type { TaskRecord, TaskPriority } from './index.js';

// Pure builder for the handoff notification. Returns a plain, dependency-free
// object that is structurally compatible with @agent-comms/mailbox's
// SendAgentMailInput — the CLI maps it into the mailbox so the store core never
// depends on the mailbox (keeps it unit-testable without SQLite). This is the
// "reuse agent-mail's event path" seam: the ledger links to mail, doesn't
// reimplement it.

export interface HandoffNotificationLink {
  label: string;
  target: string;
}

export interface HandoffNotification {
  fromAgent: string;
  toAgent: string;
  type: 'handoff';
  subject: string;
  bodyMd: string;
  priority: 'low' | 'normal' | 'high';
  requiresResponse: boolean;
  links: HandoffNotificationLink[];
}

function mailPriority(p: TaskPriority): 'low' | 'normal' | 'high' {
  return p === 'med' ? 'normal' : p;
}

export function buildHandoffNotification(task: TaskRecord, fromAgent: string): HandoffNotification {
  if (!task.handoffTo) {
    throw new Error(`Task ${task.id} has no handoffTo set; call handoffTask first.`);
  }
  const bodyMd = [
    `Task handed off to you: ${task.title}`,
    '',
    `- ledger id: ${task.id}`,
    `- priority: ${task.priority}`,
    task.context ? `- context: ${task.context}` : '',
    task.blockedOn ? `- blocked on: ${task.blockedOn}` : '',
    '',
    `Run: task-ledger show --id ${task.id}`,
  ]
    .filter((line) => line !== '')
    .join('\n');

  return {
    fromAgent,
    toAgent: task.handoffTo,
    type: 'handoff',
    subject: `Task handoff: ${task.title}`,
    bodyMd,
    priority: mailPriority(task.priority),
    requiresResponse: false,
    links: [
      { label: 'task', target: `task-ledger:${task.id}` },
      ...task.links.map((l) => ({ label: 'ref', target: l })),
    ],
  };
}
