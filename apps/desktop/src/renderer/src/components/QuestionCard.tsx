import { useId, useState } from 'react';
import { ChevronDown, Globe, MessageCircleQuestion, Package, Star } from 'lucide-react';
import type { Approval, QuestionPayload } from '@plenum/shared';
import { Button, ProviderDot } from './bits';
import { inputClass } from './form';
import { relative } from './PlanUsage';
import { useProjects } from '@/lib/projects';
import { providerName } from '@/lib/store';
import { settle } from '@/lib/settle';

/** Install commands Plenum runs itself once approved (mirrors the engine's allow-list). */
const RUNNABLE =
  /^(npm|pnpm|yarn|bun) (add|install|i)\b|^(pip|pip3|python -m pip) install\b|^uv add\b|^cargo add\b|^go get\b|^dotnet add package\b/i;

/** "npm install -D howler vitest" → "howler, vitest". */
function packagesOf(command: string | undefined): string | undefined {
  if (!command) return undefined;
  const words = command
    .trim()
    .replace(
      /^(python -m pip|npm|pnpm|yarn|bun|pip3?|uv|cargo|go|dotnet)\s+(add package|install|add|get|i)\s*/i,
      '',
    )
    .split(/\s+/)
    .filter((w) => w && !w.startsWith('-'));
  return words.length ? words.join(', ') : undefined;
}

/**
 * An agent's question or permission request, answerable in place: option chips (the
 * recommended one starred), your own words, or for installs and network a yes or no.
 */
export function QuestionCard({
  approval,
  projectName,
  taskTitle,
  compact = false,
}: {
  approval: Approval;
  /** Shown in the Inbox, where items from every project mix. */
  projectName?: string;
  taskTitle?: string;
  compact?: boolean;
}) {
  const decide = useProjects((s) => s.decide);
  const q = approval.payload as QuestionPayload;
  const [choice, setChoice] = useState<string | null>(null);
  const [own, setOwn] = useState('');
  const [writing, setWriting] = useState(q.options.length === 0);
  const [busy, setBusy] = useState(false);
  const groupId = useId();

  const answer = writing ? own.trim() : choice;
  const send = async (decision: 'approved' | 'rejected', text?: string) => {
    setBusy(true);
    await decide(approval.id, decision, text ? { answer: text } : {});
    setBusy(false);
  };

  const Icon =
    approval.kind === 'install'
      ? Package
      : approval.kind === 'network'
        ? Globe
        : MessageCircleQuestion;
  const command = q.permission?.command;
  const permission = approval.kind !== 'question';
  const packages = packagesOf(command);
  // Permission requests get a short title of our own; the agent's wording goes under "Why".
  const title = !permission
    ? q.question
    : approval.kind === 'install'
      ? `Install ${packages ?? 'a package'}?`
      : 'Allow network access?';

  return (
    <article
      aria-label={q.question}
      className={`rounded-2xl border border-warn/35 bg-panel shadow-card ${compact ? 'p-4' : 'p-5'}`}
    >
      <div className="flex items-start gap-3.5">
        <div className="grid size-9 shrink-0 place-items-center rounded-xl bg-warn-soft text-warn">
          <Icon className="size-4.5" aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px] text-faint">
            {projectName && <span className="font-semibold text-ink">{projectName}</span>}
            {q.provider && (
              <span className="inline-flex items-center gap-1">
                <ProviderDot provider={q.provider} size={6} />
                {providerName(q.provider)} asks
                {q.stage === 'plan'
                  ? ' while planning'
                  : q.stage === 'review'
                    ? ' while reviewing'
                    : ''}
              </span>
            )}
            {taskTitle && <span className="truncate">· {taskTitle}</span>}
            <span className="ml-auto shrink-0">{relative(approval.createdAt, 'past')}</span>
          </div>
          <h3 className="selectable mt-1 text-[14.5px] leading-snug font-semibold">{title}</h3>
          {!permission && q.why && (
            <p className="selectable mt-0.5 text-[12.5px] text-muted">{q.why}</p>
          )}

          {approval.kind === 'question' ? (
            <>
              {q.options.length > 0 && (
                <div
                  role="radiogroup"
                  aria-labelledby={groupId}
                  className="mt-3 flex flex-wrap gap-1.5"
                >
                  <span id={groupId} className="sr-only">
                    Options
                  </span>
                  {q.options.map((o) => {
                    const on = !writing && choice === o;
                    return (
                      <button
                        key={o}
                        type="button"
                        role="radio"
                        aria-checked={on}
                        onClick={() => {
                          setWriting(false);
                          setChoice(o);
                        }}
                        className={`inline-flex min-h-8 max-w-full items-center gap-1.5 rounded-2xl border px-3 py-1 text-left text-[12.5px] leading-snug font-medium transition ${
                          on
                            ? 'border-accent bg-accent text-white'
                            : 'border-line-strong bg-panel hover:border-accent/50 hover:bg-accent-soft/50'
                        }`}
                      >
                        {o === q.recommended && (
                          <Star
                            className={`size-3 shrink-0 ${on ? 'fill-white' : 'fill-warn text-warn'}`}
                            aria-label="Recommended"
                          />
                        )}
                        {o}
                      </button>
                    );
                  })}
                  <button
                    type="button"
                    role="radio"
                    aria-checked={writing}
                    onClick={() => setWriting(true)}
                    className={`inline-flex h-8 items-center rounded-full border border-dashed px-3 text-[12.5px] font-medium ${
                      writing
                        ? 'border-accent text-accent-ink'
                        : 'border-line-strong text-muted hover:text-ink'
                    }`}
                  >
                    Write my own
                  </button>
                </div>
              )}
              {writing && (
                <input
                  autoFocus={q.options.length > 0}
                  value={own}
                  onChange={(e) => setOwn(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && own.trim()) settle(send('approved', own.trim()));
                  }}
                  aria-label="Your answer"
                  placeholder="Your answer"
                  className={`${inputClass} mt-3`}
                />
              )}
              <div className="mt-3 flex items-center justify-end gap-2">
                {q.recommended && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => settle(send('approved', q.recommended))}
                    title="Use the agent's recommendation"
                  >
                    Decide for me
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="primary"
                  disabled={busy || !answer}
                  onClick={() => answer && void send('approved', answer)}
                >
                  {busy ? 'Sending…' : 'Answer'}
                </Button>
              </div>
            </>
          ) : (
            <>
              <p className="mt-1 text-[12.5px] text-muted">
                {approval.kind === 'network' ? (
                  'Gives the builder network access for one attempt of this task.'
                ) : command && RUNNABLE.test(command.trim()) ? (
                  <>
                    Plenum runs{' '}
                    <code className="selectable rounded bg-sunken px-1.5 py-0.5 font-mono text-[12px] text-ink">
                      {command}
                    </code>{' '}
                    itself, then the task continues.
                  </>
                ) : (
                  <>
                    Plenum can't run{' '}
                    <code className="selectable rounded bg-sunken px-1.5 py-0.5 font-mono text-[12px] text-ink">
                      {command ?? 'this'}
                    </code>{' '}
                    for you. Install it yourself, then allow.
                  </>
                )}
              </p>
              <div className="mt-3 flex items-center gap-2">
                <details className="group min-w-0 flex-1 text-[12px] text-faint">
                  <summary className="inline-flex cursor-pointer list-none items-center gap-1 font-medium hover:text-ink">
                    <ChevronDown className="size-3.5 -rotate-90 transition group-open:rotate-0" />
                    Why it's asking
                  </summary>
                  <div className="selectable mt-1.5 space-y-1 text-[12.5px] leading-relaxed text-muted">
                    <p>{q.question}</p>
                    {q.why && <p>{q.why}</p>}
                    {q.permission?.alternative && (
                      <p>
                        <span className="font-medium text-ink">If you decline:</span>{' '}
                        {q.permission.alternative}
                      </p>
                    )}
                  </div>
                </details>
                <Button
                  size="sm"
                  disabled={busy}
                  className="self-start"
                  onClick={() => settle(send('rejected', q.permission?.alternative))}
                >
                  Decline
                </Button>
                <Button
                  size="sm"
                  variant="primary"
                  disabled={busy}
                  className="self-start"
                  onClick={() => settle(send('approved'))}
                >
                  {approval.kind === 'install' ? 'Allow install' : 'Allow once'}
                </Button>
              </div>
            </>
          )}
        </div>
      </div>
    </article>
  );
}
