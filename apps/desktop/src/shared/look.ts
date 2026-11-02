import type { AppearanceSettings } from '@conclave/shared';

/**
 * The page side of Appearance and accessibility (F3): attributes the stylesheet keys off.
 * Theme and text size are the window's (main process); these are the rest.
 */
export function applyLook(root: HTMLElement, look: AppearanceSettings): void {
  root.dataset.motion = look.motion;
  root.dataset.contrast = look.contrast;
  root.dataset.focus = look.focusAlways ? 'always' : 'keyboard';
  root.dataset.announce = look.announce ? 'on' : 'off';
}
