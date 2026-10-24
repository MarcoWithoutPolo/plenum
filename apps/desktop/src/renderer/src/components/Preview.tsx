import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ExternalLink, Monitor, RefreshCw, Smartphone, Tablet, X } from 'lucide-react';
import type { PreviewResult } from '@conclave/core';
import { Button } from './bits';
import { Segmented } from './form';
import { api } from '@/lib/api';
import { errorText } from '@/lib/store';

const DEVICES = {
  desktop: { width: 1280, height: 800, label: 'Desktop', icon: Monitor },
  tablet: { width: 820, height: 1000, label: 'Tablet', icon: Tablet },
  phone: { width: 390, height: 844, label: 'Phone', icon: Smartphone },
} as const;
type Device = keyof typeof DEVICES;

/**
 * A live preview of a web project inside the app: what's merged so far, or one task's change.
 * The page is shown at its real width (scaled down to fit) in a sandboxed frame.
 */
export function PreviewPane({
  projectId,
  taskId,
  title,
  onClose,
}: {
  projectId: string;
  taskId?: string;
  title: string;
  onClose: () => void;
}) {
  const [state, setState] = useState<PreviewResult | { kind: 'loading' }>({ kind: 'loading' });
  const [device, setDevice] = useState<Device>('desktop');
  const [reload, setReload] = useState(0);
  const [logs, setLogs] = useState('');
  const pane = useRef<HTMLElement>(null);
  // A block body: scrollIntoView returns a promise in newer Chromium, which React would call.
  useEffect(() => {
    pane.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [taskId]);

  const open = async () => {
    setState({ kind: 'loading' });
    try {
      setState(await api().projects.preview(projectId, taskId));
    } catch (err) {
      setState({ kind: 'failed', error: errorText(err), logs: '' });
    }
  };
  useEffect(() => {
    void open();
  }, [projectId, taskId]);
  // A dev server's output, for when something looks off.
  useEffect(() => {
    if (state.kind !== 'ready' || state.static) return;
    const tick = () => void api().projects.previewLogs(projectId, taskId).then(setLogs);
    tick();
    const t = window.setInterval(tick, 5000);
    return () => window.clearInterval(t);
  }, [state, projectId, taskId]);

  return (
    <section
      ref={pane}
      aria-label={`Preview: ${title}`}
      className="mt-5 overflow-hidden rounded-2xl border border-line bg-panel shadow-card"
    >
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line px-4 py-2.5">
        <h2 className="min-w-0 flex-1 truncate text-[13.5px] font-semibold">
          Preview <span className="font-normal text-faint">· {title}</span>
        </h2>
        {state.kind === 'ready' && (
          <>
            <Segmented
              size="sm"
              label="Device width"
              value={device}
              onChange={setDevice}
              options={(Object.keys(DEVICES) as Device[]).map((d) => {
                const Icon = DEVICES[d].icon;
                return {
                  value: d,
                  title: `${DEVICES[d].label}, ${DEVICES[d].width} px`,
                  label: (
                    <span className="inline-flex items-center gap-1.5">
                      <Icon className="size-3.5" aria-hidden />
                      {DEVICES[d].label}
                    </span>
                  ),
                };
              })}
            />
            <Button
              size="sm"
              variant="ghost"
              aria-label="Reload"
              onClick={() => setReload((n) => n + 1)}
            >
              <RefreshCw className="size-3.5" aria-hidden />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              aria-label="Open in browser"
              onClick={() => void api().openExternal(state.url)}
            >
              <ExternalLink className="size-3.5" aria-hidden />
            </Button>
          </>
        )}
        <Button size="sm" variant="ghost" aria-label="Close the preview" onClick={onClose}>
          <X className="size-4" aria-hidden />
        </Button>
      </header>

      {state.kind === 'loading' && (
        <p className="px-4 py-10 text-center text-[13px] text-muted">Starting the preview…</p>
      )}
      {state.kind === 'none' && (
        <p className="px-4 py-10 text-center text-[13px] text-muted">{state.reason}</p>
      )}
      {state.kind === 'needs_approval' && (
        <PreviewApproval
          command={state.command}
          onAllow={async () => {
            await api().projects.allowPreview(projectId, state.command);
            await open();
          }}
          onCancel={onClose}
        />
      )}
      {state.kind === 'failed' && (
        <div className="px-4 py-4">
          <p className="text-[13px] font-medium text-danger">
            The preview didn’t start: {state.error}
          </p>
          {state.logs && (
            <pre className="mt-2 max-h-48 overflow-auto rounded-xl bg-sunken p-3 font-mono text-[11.5px] text-muted">
              {state.logs}
            </pre>
          )}
          <Button size="sm" className="mt-3" onClick={() => void open()}>
            Try again
          </Button>
        </div>
      )}
      {state.kind === 'ready' && (
        <>
          <ScaledFrame
            key={`${state.url}-${reload}`}
            url={state.url}
            width={DEVICES[device].width}
            height={DEVICES[device].height}
            title={`${title} at ${DEVICES[device].width} px`}
          />
          <p className="flex flex-wrap items-center gap-x-3 border-t border-line px-4 py-2 text-[12px] text-faint">
            <span>
              {state.static
                ? 'Served by Conclave on this computer. No project code runs outside the page.'
                : 'Running the project’s own dev server on this computer.'}{' '}
              Light or dark follows your system; the task’s Screenshots show both.
            </span>
            <span className="font-mono">{state.url}</span>
          </p>
          {!state.static && logs && (
            <details className="border-t border-line px-4 py-2 text-[12px]">
              <summary className="cursor-pointer text-muted">Server output</summary>
              <pre className="mt-2 max-h-48 overflow-auto rounded-xl bg-sunken p-3 font-mono text-[11.5px] text-muted">
                {logs}
              </pre>
            </details>
          )}
        </>
      )}
    </section>
  );
}

/** The page at its real width, scaled down to fit, in a sandboxed frame. */
function ScaledFrame({
  url,
  width,
  height,
  title,
}: {
  url: string;
  width: number;
  height: number;
  title: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState(width);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setRoom(el.clientWidth - 32);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const scale = Math.min(1, room / width);
  return (
    <div ref={box} className="flex justify-center bg-sunken/60 px-4 py-4">
      <div
        className="overflow-hidden rounded-xl border border-line-strong bg-panel shadow-card"
        style={{ width: width * scale, height: height * scale }}
      >
        <iframe
          src={url}
          title={title}
          // Its own origin, so it can't reach the app; no pop-ups, no leaving the frame.
          sandbox="allow-scripts allow-forms allow-same-origin"
          style={{
            width,
            height,
            border: 0,
            transform: `scale(${scale})`,
            transformOrigin: 'top left',
          }}
        />
      </div>
    </div>
  );
}

/** The one-time question before a project's own dev server runs on your computer. */
export function PreviewApproval({
  command,
  onAllow,
  onCancel,
}: {
  command: string;
  onAllow: () => Promise<void>;
  onCancel: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <div role="group" aria-label="Allow the preview command" className="px-5 py-5">
      <p className="text-[14px] font-semibold">
        Start a preview with <span className="font-mono text-[13px]">{command}</span>?
      </p>
      <p className="mt-1 max-w-2xl text-[13px] text-muted">
        It runs the project’s own code on your computer, in this project’s folder, outside any
        agent’s sandbox. You’ll be asked again if the command changes.
      </p>
      {error && <p className="mt-2 text-[12.5px] text-danger">{error}</p>}
      <div className="mt-4 flex gap-2">
        <Button onClick={onCancel}>Not now</Button>
        <Button
          variant="primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError('');
            try {
              await onAllow();
            } catch (err) {
              setError(errorText(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? 'Starting…' : 'Allow for this project'}
        </Button>
      </div>
    </div>
  );
}
