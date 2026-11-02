import { api } from '@/lib/api';
import { Dialog } from './Dialog';

/** Every keyboard shortcut in one list (Settings → Keyboard shortcuts, Ctrl+/ or ?). */
export function Shortcuts({ open, onClose }: { open: boolean; onClose: () => void }) {
  const mod = api().platform === 'darwin' ? '⌘' : 'Ctrl+';
  const groups: [string, [string, string][]][] = [
    [
      'Anywhere',
      [
        [`${mod}N`, 'New chat'],
        [`${mod}/ or ?`, 'This list'],
        ['Esc', 'Close the menu, dialog or panel on top'],
        ['Tab, Shift+Tab', 'Move between controls'],
      ],
    ],
    [
      'Writing a message',
      [
        ['Enter', 'Send'],
        ['Shift+Enter', 'New line'],
      ],
    ],
    [
      'Menus and choices',
      [
        ['↑ ↓', 'Move through a list'],
        ['← →', 'Change a choice (effort, level, theme)'],
        ['Home, End', 'First or last item'],
        ['Enter, Space', 'Pick'],
        ['Type', 'Search the model list'],
      ],
    ],
  ];
  return (
    <Dialog open={open} onClose={onClose} title="Keyboard shortcuts" width={520}>
      <div className="flex flex-col gap-5">
        {groups.map(([title, keys]) => (
          <section key={title} aria-labelledby={`keys-${title}`}>
            <h3
              id={`keys-${title}`}
              className="text-[12px] font-semibold tracking-wide text-muted uppercase"
            >
              {title}
            </h3>
            <dl className="mt-2 grid grid-cols-[minmax(8rem,auto)_1fr] gap-x-4 gap-y-2 text-[13px]">
              {keys.map(([k, what]) => (
                <div key={k} className="contents">
                  <dt>
                    <kbd className="rounded-md border border-line-strong bg-sunken px-1.5 py-0.5 font-mono text-[12px]">
                      {k}
                    </kbd>
                  </dt>
                  <dd className="text-muted">{what}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Dialog>
  );
}
