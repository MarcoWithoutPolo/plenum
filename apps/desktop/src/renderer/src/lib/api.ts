import type { PlenumApi } from '../../../shared/api';

declare global {
  interface Window {
    plenum?: PlenumApi;
  }
}

/** The bridge from the preload. Missing only when the page is opened outside Electron. */
export function api(): PlenumApi {
  if (!window.plenum) throw new Error('Plenum must run inside its desktop app.');
  return window.plenum;
}

export function newRequestId(): string {
  return `r_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
