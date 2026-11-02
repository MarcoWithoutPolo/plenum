import type { Seat } from '@conclave/shared';
import type { SettingsStore } from './store/settings.js';

/**
 * v1.0 F2: a seat that leaves its model or effort on "Default" takes that AI's default from
 * Settings (Accounts sets it). A seat that names them keeps its own; nothing set means the CLI's
 * own setting, as before.
 */
export function resolveSeat(seat: Seat, settings: SettingsStore): Seat {
  const own = settings.get().defaults.providers[seat.provider];
  if (!own) return seat;
  return {
    ...seat,
    ...(seat.model === undefined && own.model && { model: own.model }),
    ...(seat.effort === undefined && own.effort && { effort: own.effort }),
  };
}

/** The model and effort options for an agent run, with the AI's defaults filled in. */
export function seatOptions(
  seat: Seat,
  settings: SettingsStore,
): { model?: string; effort?: string } {
  const s = resolveSeat(seat, settings);
  return { ...(s.model && { model: s.model }), ...(s.effort && { effort: s.effort }) };
}
