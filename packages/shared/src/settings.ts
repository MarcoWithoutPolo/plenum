import { z } from 'zod';

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

/** App-wide settings, stored in the settings table. Unknown or missing keys get defaults. */
export const AppSettings = z.object({
  notifications: NotificationSettings.prefault({}),
});
export type AppSettings = z.infer<typeof AppSettings>;
