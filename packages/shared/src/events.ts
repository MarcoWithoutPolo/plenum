import { z } from 'zod';
import { ProviderId } from './providers.js';

/**
 * The one event vocabulary every adapter maps its CLI's output onto.
 * Chat, council, the brain loop and the UI only ever see these.
 */
const base = {
  provider: ProviderId,
  runId: z.string(),
  at: z.number(),
};

export const Usage = z.object({
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  cachedInputTokens: z.number().optional(),
  costUsd: z.number().optional(),
});
export type Usage = z.infer<typeof Usage>;

export const AgentEvent = z.discriminatedUnion('type', [
  z.object({
    ...base,
    type: z.literal('session'),
    sessionId: z.string(),
    model: z.string().optional(),
  }),
  z.object({ ...base, type: z.literal('message.delta'), text: z.string() }),
  z.object({ ...base, type: z.literal('message.done'), text: z.string() }),
  z.object({
    ...base,
    type: z.literal('tool.call'),
    tool: z.string(),
    input: z.unknown().optional(),
  }),
  z.object({
    ...base,
    type: z.literal('file.edit'),
    path: z.string(),
    kind: z.enum(['add', 'update', 'delete']).optional(),
  }),
  z.object({ ...base, type: z.literal('usage'), usage: Usage }),
  z.object({
    ...base,
    type: z.literal('rate_limit'),
    message: z.string(),
    resetsAt: z.number().optional(),
  }),
  z.object({ ...base, type: z.literal('error'), message: z.string() }),
  z.object({
    ...base,
    type: z.literal('done'),
    ok: z.boolean(),
    exitCode: z.number().nullable(),
    durationMs: z.number(),
  }),
]);
export type AgentEvent = z.infer<typeof AgentEvent>;
export type AgentEventType = AgentEvent['type'];
