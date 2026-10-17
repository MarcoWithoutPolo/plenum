import { Gauge } from 'lucide-react';
import type { Seat } from '@conclave/shared';
import type { ProviderInfo } from '../../../shared/api';
import { useApp } from '@/lib/store';

/** Effort levels the seat's model accepts, plus what "default" currently means. */
export function effortOptions(
  seat: Seat,
  providers: ProviderInfo[],
): { levels: string[]; defaultLevel?: string } {
  const info = providers.find((p) => p.provider === seat.provider);
  if (!info) return { levels: [] };
  const modelId = seat.model ?? info.defaultModel;
  const model = modelId ? info.models.find((m) => m.id === modelId) : undefined;
  const levels = model?.efforts?.length ? model.efforts : (info.efforts ?? []);
  // The CLI's configured effort applies to any model that supports it; otherwise the model's own default.
  const defaultLevel =
    info.defaultEffort && levels.includes(info.defaultEffort)
      ? info.defaultEffort
      : model?.defaultEffort;
  return { levels, ...(defaultLevel && { defaultLevel }) };
}

/** Drop an effort the newly picked model doesn't support. */
export function fitEffort(seat: Seat, providers: ProviderInfo[]): Seat {
  if (!seat.effort) return seat;
  const { levels } = effortOptions(seat, providers);
  if (levels.includes(seat.effort)) return seat;
  const { effort: _dropped, ...rest } = seat;
  return rest;
}

export function EffortPicker({ value, onChange }: { value: Seat; onChange: (seat: Seat) => void }) {
  const providers = useApp((s) => s.providers);
  const { levels, defaultLevel } = effortOptions(value, providers);
  if (levels.length === 0) return null;

  return (
    <label
      title="Reasoning effort: lower is faster and uses less of your plan"
      className="no-drag inline-flex h-7 items-center gap-1.5 rounded-lg border border-line-strong bg-panel pr-1 pl-2 text-[12.5px] font-medium hover:bg-sunken"
    >
      <Gauge className="size-3.5 text-faint" aria-hidden />
      <span className="sr-only">Reasoning effort</span>
      <select
        aria-label="Reasoning effort"
        value={value.effort ?? ''}
        onChange={(e) => {
          const effort = e.target.value;
          const { effort: _old, ...rest } = value;
          onChange(effort ? { ...rest, effort } : rest);
        }}
        className="h-6 cursor-pointer rounded bg-transparent text-[12.5px] outline-none"
      >
        <option value="">{defaultLevel ? `default (${defaultLevel})` : 'default effort'}</option>
        {levels.map((level) => (
          <option key={level} value={level}>
            {level}
          </option>
        ))}
      </select>
    </label>
  );
}
