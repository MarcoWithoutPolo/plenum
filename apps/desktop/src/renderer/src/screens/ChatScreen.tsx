import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeftRight, Plug, TriangleAlert } from 'lucide-react';
import type { Message, Seat } from '@conclave/shared';
import { Composer } from '@/components/Composer';
import { Markdown } from '@/components/Markdown';
import { EffortPicker, fitEffort } from '@/components/EffortPicker';
import { ModelPicker } from '@/components/ModelPicker';
import { Button, ProviderDot, Thinking, formatStats, usageTitle } from '@/components/bits';
import {
  NEW,
  defaultSeat,
  providerName,
  readyProviders,
  seatOf,
  useApp,
  type LiveChat,
} from '@/lib/store';

export function ChatScreen({ threadId }: { threadId?: string }) {
  const providers = useApp((s) => s.providers);
  const lastSeat = useApp((s) => s.lastSeat);
  const detail = useApp((s) => (threadId ? s.details[threadId] : undefined));
  const live = useApp((s) => s.liveChats[threadId ?? NEW]);
  const sendChat = useApp((s) => s.sendChat);
  const cancel = useApp((s) => s.cancel);
  const open = useApp((s) => s.open);

  const thread = detail?.thread;
  const [seat, setSeat] = useState<Seat | undefined>(() =>
    thread ? seatOf(thread) : defaultSeat(providers, lastSeat),
  );
  // Adopt the thread's seat once it loads, and pick a default when providers arrive.
  useEffect(() => {
    if (thread) setSeat(seatOf(thread));
  }, [thread?.id]);
  useEffect(() => {
    if (!seat) setSeat(defaultSeat(providers, lastSeat));
  }, [providers, lastSeat, seat]);

  const messages = detail?.messages ?? [];
  const noProviders = readyProviders(providers).length === 0;
  const isEmpty = messages.length === 0 && !live;

  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages.length, live?.text, live?.status]);

  const send = (text: string) => {
    if (seat) void sendChat(threadId, text, seat);
  };

  const composer = (
    <Composer
      running={Boolean(live)}
      disabled={noProviders || !seat}
      onSend={send}
      onStop={() => live && cancel(live.requestId)}
      placeholder={
        noProviders
          ? 'Connect an AI account first'
          : `Message ${seat ? providerName(seat.provider) : ''}…`
      }
      toolbar={
        seat && (
          <>
            <ModelPicker
              value={seat}
              onChange={(next) => setSeat(fitEffort(next, providers))}
              compact
            />
            <EffortPicker value={seat} onChange={setSeat} />
          </>
        )
      }
    />
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="drag flex h-10 shrink-0 items-center gap-3 border-b border-transparent px-6">
        <h1 className="truncate text-[13.5px] font-medium text-muted">{thread?.title ?? ''}</h1>
      </header>

      {isEmpty ? (
        <div className="flex flex-1 flex-col items-center justify-center px-8 pb-24">
          <div className="w-full max-w-2xl">
            <h2 className="text-center text-[26px] font-semibold tracking-tight">
              What are we working on?
            </h2>
            <p className="mt-2 mb-7 text-center text-[14px] text-muted">
              Pick who answers. You can switch models mid-chat, and the new one sees the whole
              conversation.
            </p>
            {noProviders && <ConnectPrompt onOpen={() => open({ name: 'accounts' })} />}
            {composer}
          </div>
        </div>
      ) : (
        <>
          <div
            ref={scroller}
            onScroll={(e) => {
              const el = e.currentTarget;
              stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
            }}
            className="min-h-0 flex-1 overflow-y-auto"
          >
            <div className="mx-auto flex max-w-3xl flex-col gap-6 px-8 pt-4 pb-10">
              <MessageList messages={messages} />
              {live && <LiveExchange live={live} previous={lastAssistant(messages)} />}
            </div>
          </div>
          <div className="mx-auto w-full max-w-3xl px-8 pb-5">{composer}</div>
        </>
      )}
    </div>
  );
}

function lastAssistant(messages: Message[]): Message | undefined {
  return [...messages].reverse().find((m) => m.role === 'assistant');
}

function MessageList({ messages }: { messages: Message[] }) {
  const items = useMemo(() => {
    let previous: Message | undefined;
    return messages.map((m) => {
      const switched =
        m.role === 'assistant' && previous !== undefined && previous.provider !== m.provider;
      if (m.role === 'assistant') previous = m;
      return { m, switched };
    });
  }, [messages]);
  return (
    <>
      {items.map(({ m, switched }) => (
        <div key={m.id} className="flex flex-col gap-6">
          {switched && m.provider && <SwitchMarker name={providerName(m.provider)} />}
          {m.role === 'user' ? <UserBubble text={m.content} /> : <AssistantMessage message={m} />}
        </div>
      ))}
    </>
  );
}

function SwitchMarker({ name }: { name: string }) {
  return (
    <div className="flex items-center gap-3 text-[11.5px] text-faint">
      <span className="h-px flex-1 bg-line" />
      <ArrowLeftRight className="size-3" />
      Switched to {name}, which sees the whole conversation
      <span className="h-px flex-1 bg-line" />
    </div>
  );
}

function UserBubble({ text }: { text: string }) {
  return (
    <div className="flex justify-end">
      <div className="selectable max-w-[82%] rounded-2xl rounded-br-md bg-sunken px-4 py-2.5 text-[14.5px] leading-relaxed whitespace-pre-wrap">
        {text}
      </div>
    </div>
  );
}

function AssistantHeader({
  provider,
  model,
  effort,
  meta,
  metaTitle,
}: {
  provider: Message['provider'];
  model?: string | null;
  effort?: string | null;
  meta?: string;
  metaTitle?: string;
}) {
  return (
    <div className="mb-1.5 flex items-center gap-2 text-[12.5px]">
      {provider && <ProviderDot provider={provider} />}
      <span className="font-semibold">{provider ? providerName(provider) : 'Assistant'}</span>
      {model && <span className="text-faint">{model}</span>}
      {effort && <span className="text-faint">· {effort} effort</span>}
      {meta && (
        <span className="cursor-default text-faint" title={metaTitle}>
          · {meta}
        </span>
      )}
    </div>
  );
}

function AssistantMessage({ message }: { message: Message }) {
  return (
    <div>
      <AssistantHeader
        provider={message.provider}
        model={message.model}
        effort={message.effort}
        meta={formatStats(message.durationMs, message.usage)}
        {...(message.usage && { metaTitle: usageTitle(message.usage) })}
      />
      {message.ok ? (
        <Markdown text={message.content} />
      ) : (
        <ErrorBox text={message.error ?? 'No reply'} />
      )}
    </div>
  );
}

function LiveExchange({ live, previous }: { live: LiveChat; previous?: Message }) {
  const switched = previous !== undefined && previous.provider !== live.seat.provider;
  return (
    <div className="flex flex-col gap-6">
      <UserBubble text={live.userText} />
      {switched && <SwitchMarker name={providerName(live.seat.provider)} />}
      <div aria-live="polite">
        <AssistantHeader
          provider={live.seat.provider}
          model={live.seat.model ?? null}
          effort={live.seat.effort ?? null}
        />
        {live.text ? <Markdown text={live.text} streaming /> : <Thinking />}
      </div>
    </div>
  );
}

export function ErrorBox({ text }: { text: string }) {
  return (
    <div className="selectable flex items-start gap-2 rounded-xl border border-danger/25 bg-danger-soft px-3.5 py-2.5 text-[13px] text-danger">
      <TriangleAlert className="mt-0.5 size-4 shrink-0" />
      <span>{text}</span>
    </div>
  );
}

export function ConnectPrompt({ onOpen }: { onOpen: () => void }) {
  return (
    <div className="mb-4 flex items-center gap-3 rounded-xl border border-line bg-sunken px-4 py-3 text-[13px] text-muted">
      <Plug className="size-4 shrink-0" />
      <span className="flex-1">No AI account is connected yet.</span>
      <Button size="sm" variant="primary" onClick={onOpen}>
        Connect accounts
      </Button>
    </div>
  );
}
