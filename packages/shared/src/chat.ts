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
  /** Reasoning effort for new messages; null means the CLI's own setting. */
  effort: z.string().nullable(),
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
  effort: z.string().nullable(),
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

/** Who answers: a provider plus optional model and reasoning effort (the CLI's defaults when omitted). */
/** A model or effort id goes to a CLI as an argument: it may never look like an option (U26). */
export const CliValue = z
  .string()
  .max(200)
  .regex(/^[^-\s][^\s]*$/, 'A model or effort id can’t start with "-" or contain spaces');

export const Seat = z.object({
  provider: ProviderId,
  model: CliValue.optional(),
  effort: CliValue.optional(),
});
export type Seat = z.infer<typeof Seat>;

/** An id the window passes back (a thread, a request): letters, digits, `_` and `-` only. */
export const WireId = z.string().regex(/^[\w-]{1,100}$/, 'Invalid id');

/** What the window sends to start a chat reply (checked in the main process, U26). */
export const ChatSendInput = z.object({
  requestId: WireId,
  threadId: WireId,
  text: z.string().min(1).max(200_000),
  seat: Seat,
});

/** What the window sends to ask a council (checked in the main process, U26). */
export const CouncilAskInput = z.object({
  requestId: WireId,
  question: z.string().min(1).max(200_000),
  members: z.array(Seat).min(1).max(12),
  synthesizer: Seat,
  threadId: WireId.optional(),
});
