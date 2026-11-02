import { useMemo } from 'react';
import type { ProviderId, Seat } from '@conclave/shared';
import { api } from '@/lib/api';
import { pickerProviders, recentSeats, rememberSeat, seatToValue, valueToSeat } from '@/lib/picker';
import { useApp } from '@/lib/store';
import { ModelPicker } from './ModelPicker';
import type { PopoverTriggerProps } from './Popover';
import { mustOpen, settle } from '@/lib/settle';

export { effortNote, modelLabel } from '@/lib/picker';

/**
 * Who answers: provider, model and its effort, in one control (ModelPicker over the providers'
 * live model lists). `lockProvider` limits it to one provider (council members, team seats).
 */
export function SeatPicker({
  value,
  onChange,
  lockProvider,
  trigger,
  align = 'left',
  label = 'Choose model',
}: {
  value: Seat;
  onChange: (seat: Seat) => void;
  lockProvider?: ProviderId;
  trigger?: (props: PopoverTriggerProps & { seat: Seat }) => React.ReactNode;
  align?: 'left' | 'right';
  label?: string;
}) {
  const providers = useApp((s) => s.providers);
  const openScreen = useApp((s) => s.open);
  const shown = useMemo(
    () => (lockProvider ? providers.filter((p) => p.provider === lockProvider) : providers),
    [providers, lockProvider],
  );
  const options = useMemo(() => pickerProviders(shown), [shown]);
  const infoOf = (id: string) => providers.find((p) => p.provider === id);
  const recent = lockProvider
    ? []
    : recentSeats()
        .filter((s) => options.some((p) => p.id === s.provider && p.connected))
        .map((s) => seatToValue(s, infoOf(s.provider)));

  if (!options.length) return null;
  return (
    <ModelPicker
      providers={options}
      value={seatToValue(value, infoOf(value.provider))}
      onChange={(v) => {
        const seat = valueToSeat(v, infoOf(v.provider));
        rememberSeat(seat);
        onChange(seat);
      }}
      recent={recent}
      align={align}
      label={label}
      {...(trigger && { trigger: (props) => trigger({ ...props, seat: value }) })}
      onOpenAccounts={() => openScreen({ name: 'accounts' })}
      onSignIn={(provider) => settle(mustOpen(api().accounts.signIn(provider as ProviderId)))}
    />
  );
}
