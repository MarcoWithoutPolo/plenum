import type { ConclaveApi } from '../../../shared/api';

declare global {
  interface Window {
    conclave?: ConclaveApi;
  }
}

/** The bridge from the preload. Missing only when the page is opened outside Electron. */
export function api(): ConclaveApi {
  if (!window.conclave) throw new Error('Conclave must run inside its desktop app.');
  return window.conclave;
}

export function newRequestId(): string {
  return `r_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
