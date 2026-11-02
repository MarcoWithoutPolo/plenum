import { create } from 'zustand';

/**
 * What screen readers hear about work that finishes while you're elsewhere (F3: "Announce
 * progress"). Off when the setting is off (the look's data-announce attribute).
 */
export const useAnnouncer = create<{ text: string }>(() => ({ text: '' }));

export function announce(text: string): void {
  if (document.documentElement.dataset.announce === 'off') return;
  // A changed string is announced again even when the words repeat.
  const prev = useAnnouncer.getState().text;
  useAnnouncer.setState({ text: prev === text ? `${text} ` : text });
}
