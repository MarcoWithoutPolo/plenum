import { isAbsolute } from 'node:path';

/** Effort levels go on the command line too: lowercase words only. */
export function assertSafeEffort(effort: string | undefined): void {
  if (effort !== undefined && !/^[a-z]+$/.test(effort))
    throw new Error(`Invalid effort: ${effort}`);
}

/** Model names go on the command line, so only allow plain identifiers. */
export function assertSafeModel(model: string | undefined): void {
  if (model !== undefined && !/^[\w.:/[\]-]+$/.test(model)) {
    throw new Error(`Invalid model name: ${model}`);
  }
}

/** Session ids go on the command line: letters, digits, dashes and underscores. */
export function assertSafeSession(sessionId: string | undefined): void {
  if (sessionId !== undefined && !/^[\w-]+$/.test(sessionId)) throw new Error('Invalid session id');
}

/** An image path from Plenum's own data folder: absolute, a PNG, nothing a shell could misread. */
export function safeImage(path: string): string {
  if (!isAbsolute(path) || !/\.png$/i.test(path) || /[\r\n"]/.test(path)) {
    throw new Error(`Not a screenshot path: ${path}`);
  }
  return path;
}
