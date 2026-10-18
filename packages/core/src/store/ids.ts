import { randomBytes } from 'node:crypto';

/** Time-sortable id: base36 millis + random suffix. */
export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${randomBytes(5).toString('hex')}`;
}
