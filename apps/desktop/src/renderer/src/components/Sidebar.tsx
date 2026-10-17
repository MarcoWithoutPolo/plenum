import { useState } from 'react';
import { FolderKanban, MessageSquarePlus, MessagesSquare, Plug, Trash2, Users } from 'lucide-react';
import type { Thread } from '@conclave/shared';
import { useApp } from '@/lib/store';
import { ProviderDot, timeAgo } from './bits';

export function Sidebar() {
  const threads = useApp((s) => s.threads);
  const screen = useApp((s) => s.screen);
  const providers = useApp((s) => s.providers);
  const open = useApp((s) => s.open);
  const platform = window.conclave?.platform;

  const activeId = 'threadId' in screen ? screen.threadId : undefined;
  const ready = providers.filter((p) => p.auth === 'signed_in').length;

  return (
    <aside className="flex h-full w-[264px] shrink-0 flex-col border-r border-line bg-sidebar">
      <div
        className={`drag flex h-10 shrink-0 items-center gap-2 px-4 ${platform === 'darwin' ? 'pl-20' : ''}`}
      >
        <Logo />
        <span className="text-[13.5px] font-semibold tracking-tight">Conclave</span>
      </div>

      <div className="flex flex-col gap-0.5 px-2.5 pt-2">
        <NavButton
          icon={<MessageSquarePlus className="size-4" />}
          label="New chat"
          active={screen.name === 'chat' && !activeId}
          onClick={() => open({ name: 'chat' })}
          shortcut="Ctrl+N"
        />
        <NavButton
          icon={<Users className="size-4" />}
          label="Ask the council"
          active={screen.name === 'council' && !activeId}
          onClick={() => open({ name: 'council' })}
        />
        <NavButton
          icon={<FolderKanban className="size-4" />}
          label="Projects"
          disabled
          hint="Soon"
          onClick={() => {}}
        />
      </div>

      <div className="mt-4 flex items-center px-5 pb-1.5 text-[11.5px] font-semibold tracking-wide text-faint uppercase">
        Recent
      </div>
      <nav aria-label="Recent chats" className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-3">
        {threads.length === 0 ? (
          <p className="px-2.5 py-2 text-[12.5px] text-faint">
            Your chats and councils show up here.
          </p>
        ) : (
          threads.map((t) => (
            <ThreadRow
              key={t.id}
              thread={t}
              active={t.id === activeId}
              onOpen={() =>
                open({ name: t.mode === 'council' ? 'council' : 'chat', threadId: t.id })
              }
            />
          ))
        )}
      </nav>

      <div className="border-t border-line p-2.5">
        <NavButton
          icon={<Plug className="size-4" />}
          label="Accounts"
          active={screen.name === 'accounts'}
          onClick={() => open({ name: 'accounts' })}
          trailing={
            <span className="ml-auto flex items-center gap-1" aria-label={`${ready} connected`}>
              {providers.map((p) => (
                <span key={p.provider} className={p.auth === 'signed_in' ? '' : 'opacity-25'}>
                  <ProviderDot provider={p.provider} size={7} />
                </span>
              ))}
            </span>
          }
        />
      </div>
    </aside>
  );
}

function NavButton({
  icon,
  label,
  active,
  onClick,
  disabled,
  hint,
  shortcut,
  trailing,
}: {
  icon: React.ReactNode;
  label: string;
  active?: boolean;
  onClick: () => void;
  disabled?: boolean;
  hint?: string;
  shortcut?: string;
  trailing?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-current={active ? 'page' : undefined}
      className={`flex h-8.5 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[13.5px] transition ${
        active
          ? 'bg-panel font-medium text-ink shadow-card'
          : 'text-muted hover:bg-panel/60 hover:text-ink'
      } disabled:cursor-default disabled:opacity-55 disabled:hover:bg-transparent disabled:hover:text-muted`}
    >
      {icon}
      <span>{label}</span>
      {hint && (
        <span className="ml-auto rounded bg-sunken px-1.5 text-[10.5px] font-medium text-faint">
          {hint}
        </span>
      )}
      {shortcut && !trailing && <span className="ml-auto text-[11px] text-faint">{shortcut}</span>}
      {trailing}
    </button>
  );
}

function ThreadRow({
  thread,
  active,
  onOpen,
}: {
  thread: Thread;
  active: boolean;
  onOpen: () => void;
}) {
  const remove = useApp((s) => s.removeThread);
  const [confirm, setConfirm] = useState(false);
  return (
    <div
      className={`group relative flex items-center rounded-lg ${active ? 'bg-panel shadow-card' : 'hover:bg-panel/60'}`}
      onMouseLeave={() => setConfirm(false)}
    >
      <button
        type="button"
        onClick={onOpen}
        aria-current={active ? 'page' : undefined}
        className="flex min-w-0 flex-1 items-center gap-2.5 py-1.5 pr-8 pl-2.5 text-left"
      >
        {thread.mode === 'council' ? (
          <Users className="size-3.5 shrink-0 text-faint" />
        ) : (
          <MessagesSquare className="size-3.5 shrink-0 text-faint" />
        )}
        <span className={`min-w-0 flex-1 truncate text-[13px] ${active ? 'font-medium' : ''}`}>
          {thread.title}
        </span>
        <span className="shrink-0 text-[11px] text-faint group-hover:invisible">
          {timeAgo(thread.updatedAt)}
        </span>
      </button>
      <button
        type="button"
        aria-label={confirm ? 'Confirm delete' : `Delete ${thread.title}`}
        title={confirm ? 'Click again to delete' : 'Delete'}
        onClick={() => (confirm ? void remove(thread.id) : setConfirm(true))}
        className={`absolute right-1 hidden rounded-md p-1 group-hover:block ${
          confirm ? 'bg-danger-soft text-danger' : 'text-faint hover:bg-sunken hover:text-ink'
        }`}
      >
        <Trash2 className="size-3.5" />
      </button>
    </div>
  );
}

function Logo() {
  return (
    <svg viewBox="0 0 24 24" className="size-5" aria-hidden>
      <circle cx="12" cy="6.5" r="3.2" fill="var(--claude)" />
      <circle cx="6.5" cy="16" r="3.2" fill="var(--codex)" />
      <circle cx="17.5" cy="16" r="3.2" fill="var(--gemini)" />
      <circle cx="12" cy="13" r="2.2" fill="var(--accent)" />
    </svg>
  );
}
