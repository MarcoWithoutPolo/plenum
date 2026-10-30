import {
  effortLabel,
  findVariant,
  providerEntry,
  resolveModel,
  type ModelOption,
  type Seat,
} from '@conclave/shared';
import type { ProviderInfo } from '../../../shared/api';
import type { PickerModel, PickerProvider, PickerValue } from '@/components/ModelPicker';

/** Generic notes for effort levels a CLI doesn't describe itself. */
const EFFORT_NOTES: Record<string, string> = {
  none: 'No extra reasoning: answers straight away',
  minimal: 'Barely any reasoning, very fast',
  low: 'Fastest, and lightest on your plan',
  medium: 'Balanced speed and depth',
  high: 'Thinks longer before answering',
  xhigh: 'Thinks much longer',
  max: 'Deepest reasoning, slowest',
  ultra: 'Maximum reasoning; may split work into subtasks',
};

export function effortNote(level: string | undefined, model?: ModelOption): string {
  if (!level) return 'Uses the CLI setting';
  return model?.effortNotes?.[level] ?? EFFORT_NOTES[level] ?? effortLabel(level);
}

const BILLING = {
  plan: 'Your plan',
  credits: 'Pays per use',
  'free-local': 'Free · on your hardware',
} as const;

function toPickerModel(info: ProviderInfo, m: ModelOption, makers: number): PickerModel {
  const efforts = m.efforts?.length ? m.efforts : m.variants ? [] : (info.efforts ?? []);
  return {
    id: m.id,
    label: m.label ?? modelLabel(info, m.id),
    ...((m.description ?? (m.label && m.label !== m.id ? m.id : undefined)) && {
      note: m.description ?? m.id,
    }),
    ...(m.tags?.length && { tags: m.tags }),
    ...(efforts.length && {
      efforts: efforts.map((e) => ({ id: e, label: effortLabel(e), note: effortNote(e, m) })),
    }),
    ...(m.defaultEffort && { defaultEffort: m.defaultEffort }),
    ...(makers > 1 && m.maker && { group: m.maker }),
    ...(m.older && { older: true }),
    ...(m.fast && { fast: true }),
  };
}

/** What the picker shows for each provider: its models, status, billing and words. */
export function pickerProviders(providers: ProviderInfo[]): PickerProvider[] {
  return providers.map((info) => {
    const entry = providerEntry(info.provider);
    const connected = info.installed && info.auth === 'signed_in';
    const makers = new Set(info.models.map((m) => m.maker ?? '')).size;
    const status = info.limit
      ? 'At its usage limit'
      : connected
        ? (info.detail ?? 'Signed in')
        : info.installed
          ? 'Not signed in'
          : 'Not installed';
    const install = entry?.install;
    return {
      id: info.provider,
      name: entry?.short ?? info.displayName,
      connected,
      installed: info.installed,
      status,
      tone: info.limit ? 'warn' : connected ? 'ok' : 'off',
      ...(entry && { billing: BILLING[entry.cost] }),
      effortName: entry?.effortName ?? 'Effort',
      ...(info.defaultModel && { defaultModel: info.defaultModel }),
      models: info.models.map((m) => toPickerModel(info, m, makers)),
      install: {
        command: install?.npm
          ? `npm install -g ${install.npm}`
          : (install?.script?.windows ?? install?.docs ?? 'See Accounts'),
        signIn: info.loginHint,
        cost: entry ? BILLING[entry.cost] : 'Your plan',
      },
    };
  });
}

/** A seat as the picker sees it: the model row and the effort, even when the effort is in the id. */
export function seatToValue(seat: Seat, info: ProviderInfo | undefined): PickerValue {
  const found = info ? findVariant(info.models, seat.model) : undefined;
  if (found?.option.variants) {
    const effort = found.effort ?? seat.effort;
    return {
      provider: seat.provider,
      model: found.option.id,
      ...(effort && { effort }),
      ...(found.fast && { fast: true }),
    };
  }
  return {
    provider: seat.provider,
    ...(seat.model && { model: seat.model }),
    ...(seat.effort && { effort: seat.effort }),
  };
}

/** The seat to run: a model that carries its effort in the id gets that id and no effort flag. */
export function valueToSeat(value: PickerValue, info: ProviderInfo | undefined): Seat {
  const option = value.model ? info?.models.find((m) => m.id === value.model) : undefined;
  if (option?.variants) {
    return {
      provider: value.provider,
      model: resolveModel(option, value.effort, value.fast).model,
    };
  }
  return {
    provider: value.provider,
    ...(value.model && { model: value.model }),
    ...(value.effort && { effort: value.effort }),
  };
}

/** A model's display name: its label, or the alias capitalized ("opus" → "Opus"). */
export function modelLabel(info: ProviderInfo | undefined, id: string | undefined): string {
  if (!id) return 'Default';
  const found = info ? findVariant(info.models, id) : undefined;
  if (found) {
    const base = found.option.label ?? found.option.id;
    return found.option.variants && found.effort ? `${base} ${effortLabel(found.effort)}` : base;
  }
  return /^[a-z]+$/.test(id) ? id[0]!.toUpperCase() + id.slice(1) : id;
}

/* ── Recent choices (per viewer, best effort) ─────────────────────────── */

const RECENT_KEY = 'conclave.recentSeats';

export function recentSeats(): Seat[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    const list: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(list)
      ? list.filter((s): s is Seat => typeof s?.provider === 'string').slice(0, 3)
      : [];
  } catch {
    return [];
  }
}

export function rememberSeat(seat: Seat): void {
  try {
    const same = (a: Seat) =>
      a.provider === seat.provider && a.model === seat.model && a.effort === seat.effort;
    const list = [seat, ...recentSeats().filter((s) => !same(s))].slice(0, 3);
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    // storage unavailable: no recent chips
  }
}
