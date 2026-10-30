import { z } from 'zod';

/** Any provider id: lowercase, as the registry names them. Unknown ids survive in old rows. */
export const ProviderId = z.string().regex(/^[a-z][a-z0-9-]{1,23}$/, 'Not a provider id');
export type ProviderId = z.infer<typeof ProviderId>;

export const AuthState = z.enum(['signed_in', 'signed_out', 'unknown']);
export type AuthState = z.infer<typeof AuthState>;

/** What `detect()` reports about a provider's CLI on this machine. */
export const ProviderStatus = z.object({
  provider: ProviderId,
  installed: z.boolean(),
  version: z.string().optional(),
  executable: z.string().optional(),
  auth: AuthState,
  detail: z.string().optional(),
});
export type ProviderStatus = z.infer<typeof ProviderStatus>;

export const Role = z.enum(['chat', 'planner', 'builder', 'tester', 'reviewer', 'synthesizer']);
export type Role = z.infer<typeof Role>;
