import { randomUUID } from 'node:crypto';
import { Message } from '@a2a-js/sdk';
import type { Task } from '@a2a-js/sdk';

/** Both live settlement and restart recovery publish the same bounded failure message shape. */
export function statusMessage(task: Pick<Task, 'id' | 'contextId'>, reasonCode: string, safeMessage: string): Message {
  return Message.fromJSON({ messageId: randomUUID(), taskId: task.id, contextId: task.contextId, role: 'ROLE_AGENT',
    parts: [{ text: safeMessage }, { data: { reasonCode, safeMessage }, mediaType: 'application/json' }] });
}
