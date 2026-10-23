import { z } from 'zod';
import { ProviderId } from './providers.js';

/** Which desktop notifications to show. All on by default. */
export const NotificationSettings = z.object({
  /** A question or a permission request is waiting for you. */
  needsYou: z.boolean().default(true),
  /** Work is ready to merge or a pull request can be opened. */
  approval: z.boolean().default(true),
  /** A project met its goal. */
  done: z.boolean().default(true),
  /** A project paused after several failures in a row. */
  paused: z.boolean().default(true),
  /** An AI ran out of usage (at most once per AI per day). */
  limit: z.boolean().default(true),
});
export type NotificationSettings = z.infer<typeof NotificationSettings>;

/** One AI's limits, shared by every project. */
export const ProviderLimit = z.object({
  /** At most this many tasks build on this AI at once, across projects (default: per AI). */
  lanes: z.number().int().min(1).max(8).optional(),
  /** Share of each plan window Conclave leaves for your own use (where the CLI reports usage). */
  leaveForMe: z.number().min(0).max(0.9).default(0.1),
  /** At most this many runs a day, or no cap. */
  dailyCap: z.number().int().positive().nullable().default(null),
});
export type ProviderLimit = z.infer<typeof ProviderLimit>;

/** "Mon–Fri 9:00–17:00, Claude only": nothing new starts on these AIs then. */
export const QuietHours = z.object({
  /** 0 = Sunday … 6 = Saturday; the day the quiet time starts. */
  days: z.array(z.number().int().min(0).max(6)).min(1),
  from: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  to: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  /** Which AIs; null means all of them. */
  providers: z.array(ProviderId).nullable().default(null),
});
export type QuietHours = z.infer<typeof QuietHours>;

export const LimitSettings = z.object({
  providers: z.partialRecord(ProviderId, ProviderLimit).default({}),
  quietHours: z.array(QuietHours).default([]),
  /** Nothing new starts on any project; running steps finish. */
  pauseAll: z.boolean().default(false),
});
export type LimitSettings = z.infer<typeof LimitSettings>;

/** App-wide settings, stored in the settings table. Unknown or missing keys get defaults. */
export const AppSettings = z.object({
  notifications: NotificationSettings.prefault({}),
  limits: LimitSettings.prefault({}),
});
export type AppSettings = z.infer<typeof AppSettings>;
