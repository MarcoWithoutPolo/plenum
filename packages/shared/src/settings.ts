import { z } from 'zod';
import { CliValue } from './chat.js';
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
  /**
   * AIs billed on one plan (F12): Cursor and Grok share The X Subscription. A limit on one
   * counts for all of them.
   */
  sharedPlans: z.array(z.array(ProviderId).min(2)).default([]),
});
export type LimitSettings = z.infer<typeof LimitSettings>;

/** Local models: where Ollama runs. Another computer on your network can serve them. */
export const LocalSettings = z.object({
  host: z
    .string()
    .regex(/^https?:\/\/[\w.[\]:-]+(?::\d+)?\/?$/, 'An address like http://127.0.0.1:11434')
    .default('http://127.0.0.1:11434'),
});
export type LocalSettings = z.infer<typeof LocalSettings>;

/** One AI's default model and effort; either missing means the CLI's own setting. */
export const SeatDefault = z.object({
  model: CliValue.optional(),
  effort: CliValue.optional(),
});
export type SeatDefault = z.infer<typeof SeatDefault>;

/** v1.0 F2: what "Default" means for each AI, and which AI new chats start with. */
export const DefaultSettings = z.object({
  /** Used wherever a seat leaves the model or effort on "Default": chats, councils, teams. */
  providers: z.partialRecord(ProviderId, SeatDefault).default({}),
  /** The AI new chats start with; null means the last one you used. */
  chat: ProviderId.nullable().default(null),
});
export type DefaultSettings = z.infer<typeof DefaultSettings>;

/** v1.0 F3: how the app looks and reads. */
export const AppearanceSettings = z.object({
  theme: z.enum(['system', 'light', 'dark']).default('system'),
  /** Everything scales: text, menus, dialogs (the window's zoom). */
  textScale: z.union([z.literal(0.9), z.literal(1), z.literal(1.15), z.literal(1.3)]).default(1),
  /** Follow the system's setting, or always reduce motion. */
  motion: z.enum(['system', 'reduce']).default('system'),
  /** Stronger text and borders, solid backgrounds. */
  contrast: z.enum(['normal', 'high']).default('normal'),
  /** Focus outlines even after a mouse click, not only for the keyboard. */
  focusAlways: z.boolean().default(false),
  /** Screen readers hear when a council answers, a project needs you, a merge lands. */
  announce: z.boolean().default(true),
});
export type AppearanceSettings = z.infer<typeof AppearanceSettings>;

/** v1.0 F4: councils. */
export const CouncilSettings = z.object({
  /** Members still answering after this many minutes are skipped and the rest merged; 0 = off. */
  mergeAfterMinutes: z
    .union([z.literal(0), z.literal(1), z.literal(2), z.literal(5), z.literal(10)])
    .default(0),
});
export type CouncilSettings = z.infer<typeof CouncilSettings>;

/** v1.0 F11: what closing the window does, and starting with the computer. */
export const BackgroundSettings = z.object({
  /** Closing the window while projects run: ask, keep them running (tray), or quit. */
  onClose: z.enum(['ask', 'keep', 'quit']).default('ask'),
  /** Open Conclave, hidden in the tray, when you sign in to the computer. */
  openAtLogin: z.boolean().default(false),
});
export type BackgroundSettings = z.infer<typeof BackgroundSettings>;

/** v1.0 F7: the welcome shown once, on a new install. */
export const FirstRunSettings = z.object({
  /** Finished, with at least one AI connected: it doesn't come back. */
  done: z.boolean().default(false),
  at: z.number().nullable().default(null),
  /** Shown once and left with "Look around first". */
  seen: z.boolean().default(false),
});
export type FirstRunSettings = z.infer<typeof FirstRunSettings>;

/** App-wide settings, stored in the settings table. Unknown or missing keys get defaults. */
export const AppSettings = z.object({
  notifications: NotificationSettings.prefault({}),
  limits: LimitSettings.prefault({}),
  local: LocalSettings.prefault({}),
  defaults: DefaultSettings.prefault({}),
  appearance: AppearanceSettings.prefault({}),
  council: CouncilSettings.prefault({}),
  background: BackgroundSettings.prefault({}),
  firstRun: FirstRunSettings.prefault({}),
});
export type AppSettings = z.infer<typeof AppSettings>;
