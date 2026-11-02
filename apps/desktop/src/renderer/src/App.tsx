import { useEffect, useState } from 'react';
import { AlertCircle, X } from 'lucide-react';
import { Sidebar } from '@/components/Sidebar';
import { useProjects } from '@/lib/projects';
import { readyProviders, useApp } from '@/lib/store';
import { api } from '@/lib/api';
import { AccountsScreen } from '@/screens/AccountsScreen';
import { InboxScreen } from '@/screens/InboxScreen';
import { ChatScreen } from '@/screens/ChatScreen';
import { CouncilScreen } from '@/screens/CouncilScreen';
import { ProjectsScreen } from '@/screens/ProjectsScreen';
import { UsageScreen } from '@/screens/UsageScreen';
import { SettingsScreen } from '@/screens/SettingsScreen';
import { FirstRun } from '@/screens/FirstRun';
import { settle } from '@/lib/settle';
import { SHOW_SHORTCUTS } from '@/lib/events';
import { Shortcuts } from '@/components/Shortcuts';
import { useAnnouncer } from '@/lib/announce';

export function App() {
  const ready = useApp((s) => s.ready);
  const loadError = useApp((s) => s.loadError);
  const screen = useApp((s) => s.screen);
  const screenSeq = useApp((s) => s.screenSeq);
  const init = useApp((s) => s.init);
  const open = useApp((s) => s.open);

  const initProjects = useProjects((s) => s.init);

  // The first run (F7): on a new install, until one AI is connected and it's finished. Someone
  // with chats or projects already is past it.
  const [firstRun, setFirstRun] = useState(false);
  useEffect(() => {
    settle(
      init()
        .then(() => initProjects())
        .then(async () => {
          const settings = await api().settings.get();
          if (settings.firstRun.done) return;
          const fresh =
            useApp.getState().threads.length === 0 && useProjects.getState().summaries.length === 0;
          const connected = readyProviders(useApp.getState().providers).length > 0;
          if (fresh && !(settings.firstRun.seen && connected)) setFirstRun(true);
          else await api().settings.update({ firstRun: { done: true, at: Date.now() } });
        }),
    );
  }, [init, initProjects]);

  // A clicked notification opens its project.
  useEffect(
    () => api().onOpenProject((projectId) => open({ name: 'projects', projectId })),
    [open],
  );
  // The tray's Inbox item (F11).
  useEffect(() => api().onOpenInbox(() => open({ name: 'approvals' })), [open]);

  const [shortcuts, setShortcuts] = useState(false);
  useEffect(() => {
    const typing = (t: EventTarget | null) =>
      t instanceof HTMLElement &&
      (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        open({ name: 'chat' });
      } else if (
        ((e.ctrlKey || e.metaKey) && e.key === '/') ||
        (e.key === '?' && !typing(e.target))
      ) {
        e.preventDefault();
        setShortcuts(true);
      }
    };
    const show = () => setShortcuts(true);
    window.addEventListener('keydown', onKey);
    window.addEventListener(SHOW_SHORTCUTS, show);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener(SHOW_SHORTCUTS, show);
    };
  }, [open]);

  return (
    <div className="flex h-full">
      <Sidebar />
      <main className="relative flex min-w-0 flex-1 flex-col">
        {!ready && loadError ? (
          <div role="alert" className="grid flex-1 place-items-center px-8 text-center">
            <div className="max-w-md">
              <p className="text-[15px] font-semibold">Conclave couldn’t load</p>
              <p className="mt-1 text-[13px] text-muted">{loadError}</p>
              <button
                type="button"
                onClick={() => settle(init().then(() => initProjects()))}
                className="mt-4 rounded-xl border border-line-strong bg-panel px-4 py-2 text-[13px] font-medium hover:bg-sunken"
              >
                Retry
              </button>
            </div>
          </div>
        ) : !ready ? (
          <div className="grid flex-1 place-items-center text-muted">Loading…</div>
        ) : screen.name === 'accounts' ? (
          <AccountsScreen />
        ) : screen.name === 'projects' ? (
          <ProjectsScreen projectId={screen.projectId} />
        ) : screen.name === 'approvals' ? (
          <InboxScreen />
        ) : screen.name === 'usage' ? (
          <UsageScreen />
        ) : screen.name === 'settings' ? (
          <SettingsScreen />
        ) : screen.name === 'council' ? (
          <CouncilScreen key={screenSeq} threadId={screen.threadId} />
        ) : (
          <ChatScreen key={screen.threadId ?? 'new'} threadId={screen.threadId} />
        )}
        <Shortcuts open={shortcuts} onClose={() => setShortcuts(false)} />
        <Announcer />
        <Toast />
      </main>
      {firstRun && <FirstRun onClose={() => setFirstRun(false)} />}
    </div>
  );
}

function Toast() {
  const toast = useApp((s) => s.toast);
  if (!toast) return null;
  return (
    <div
      role="alert"
      className={`absolute right-5 bottom-5 z-50 flex max-w-md items-start gap-2.5 rounded-xl border px-3.5 py-3 text-[13px] shadow-card ${
        toast.kind === 'error'
          ? 'border-danger/30 bg-danger-soft text-danger'
          : 'border-line bg-elev text-ink'
      }`}
    >
      <AlertCircle className="mt-0.5 size-4 shrink-0" />
      <span className="selectable flex-1">{toast.text}</span>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={() => useApp.setState({ toast: undefined })}
        className="rounded p-0.5 opacity-70 hover:opacity-100"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}

/** The one live region for announcements (F3). */
function Announcer() {
  const text = useAnnouncer((s) => s.text);
  return (
    <p className="sr-only" aria-live="polite" role="status">
      {text}
    </p>
  );
}
