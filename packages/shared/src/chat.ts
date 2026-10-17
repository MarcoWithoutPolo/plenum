import { z } from 'zod';
import { Usage } from './events.js';
import { ProviderId } from './providers.js';

export const ThreadMode = z.enum(['chat', 'council']);
export type ThreadMode = z.infer<typeof ThreadMode>;

export const Thread = z.object({
  id: z.string(),
  title: z.string(),
  mode: ThreadMode,
  /** The provider and model new messages go to unless the caller picks another. */
  provider: ProviderId,
  model: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Thread = z.infer<typeof Thread>;

export const MessageKind = z.enum(['message', 'council_answer', 'council_merged']);
export type MessageKind = z.infer<typeof MessageKind>;

export const Message = z.object({
  id: z.string(),
  threadId: z.string(),
  seq: z.number(),
  role: z.enum(['user', 'assistant']),
  kind: MessageKind,
  provider: ProviderId.nullable(),
  model: z.string().nullable(),
  content: z.string(),
  ok: z.boolean(),
  error: z.string().nullable(),
  usage: Usage.nullable(),
  durationMs: z.number().nullable(),
  /** Links the answers and merged result of one council round. */
  groupId: z.string().nullable(),
  createdAt: z.number(),
});
export type Message = z.infer<typeof Message>;

/** Who answers: a provider plus an optional model (the CLI's default when omitted). */
export const Seat = z.object({ provider: ProviderId, model: z.string().optional() });
export type Seat = z.infer<typeof Seat>;
