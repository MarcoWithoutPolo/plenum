import { useEffect, useState } from 'react';
import { AlertTriangle, Info } from 'lucide-react';
import type { Shot, SnapshotSet } from '@conclave/core';
import { parseVisualIssue, type ShotBox as Box, type VisualIssue } from '@conclave/shared';
import type { TaskSnapshots } from '../../../shared/api';
import { Segmented } from './form';
import { api } from '@/lib/api';

// Screenshots never change once taken, so each is fetched once.
const cache = new Map<string, Promise<string>>();
function useShot(path: string | undefined): string | null | 'missing' {
  const [url, setUrl] = useState<string | null | 'missing'>(null);
  useEffect(() => {
    if (!path) return;
    let live = true;
    setUrl(null);
    let p = cache.get(path);
    if (!p) {
      p = api().projects.shot(path);
      cache.set(path, p);
      p.catch(() => cache.delete(path));
    }
    p.then(
      (u) => live && setUrl(u),
      () => live && setUrl('missing'),
    );
    return () => {
      live = false;
    };
  }, [path]);
  return url;
}

/** A screenshot at the width it has room for, with regions outlined. */
export function ShotImage({
  path,
  alt,
  boxes = [],
  tone = 'accent',
}: {
  path: string;
  alt: string;
  boxes?: Box[];
  tone?: 'accent' | 'danger';
}) {
  const url = useShot(path);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  if (url === 'missing') {
    return (
      <div className="grid h-24 place-items-center rounded-lg border border-dashed border-line-strong text-[12px] text-faint">
        This screenshot is no longer on disk.
      </div>
    );
  }
  if (!url) return <div className="h-40 animate-pulse rounded-lg bg-sunken" aria-label="Loading" />;
  return (
    <div className="relative overflow-hidden rounded-lg border border-line">
      <img
        src={url}
        alt={alt}
        className="block h-auto w-full"
        onLoad={(e) =>
          setSize({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })
        }
      />
      {size &&
        boxes.map(([x1, y1, x2, y2], i) => (
          <span
            key={i}
            aria-hidden
            className={`pointer-events-none absolute rounded-sm border-2 ${tone === 'danger' ? 'border-danger bg-danger/10' : 'border-accent bg-accent/10'}`}
            style={{
              left: `${(Math.min(x1, x2) / size.w) * 100}%`,
              top: `${(Math.min(y1, y2) / size.h) * 100}%`,
              width: `${(Math.abs(x2 - x1) / size.w) * 100}%`,
              height: `${(Math.abs(y2 - y1) / size.h) * 100}%`,
            }}
          />
        ))}
    </div>
  );
}

/** Before over after, revealed with a slider (arrow keys work too). */
function Slider({ before, after, label }: { before: string; after: string; label: string }) {
  const b = useShot(before);
  const a = useShot(after);
  const [at, setAt] = useState(50);
  if (!a || !b || a === 'missing' || b === 'missing') {
    return <div className="h-40 animate-pulse rounded-lg bg-sunken" aria-label="Loading" />;
  }
  return (
    <div>
      <div className="relative overflow-hidden rounded-lg border border-line">
        <img src={a} alt={`After: ${label}`} className="block h-auto w-full" />
        <img
          src={b}
          alt={`Before: ${label}`}
          className="absolute inset-0 block h-auto w-full"
          style={{ clipPath: `inset(0 ${100 - at}% 0 0)` }}
        />
        <span
          aria-hidden
          className="pointer-events-none absolute inset-y-0 w-0.5 bg-accent shadow-[0_0_0_1px_rgb(255_255_255/0.6)]"
          style={{ left: `${at}%` }}
        />
      </div>
      <label className="mt-2 flex items-center gap-2 text-[11.5px] text-faint">
        Before
        <input
          type="range"
          min={0}
          max={100}
          value={at}
          onChange={(e) => setAt(Number(e.target.value))}
          aria-label="Before and after"
          className="flex-1 accent-[var(--accent)]"
        />
        After
      </label>
    </div>
  );
}

/**
 * A task's screenshots: each page at desktop and phone width, light and dark, next to what's
 * merged so far, with the changed regions outlined and the free checks listed.
 */
export function TaskScreenshots({
  projectId,
  taskId,
  refresh,
}: {
  projectId: string;
  taskId: string;
  /** Changes when the task moves on, so new shots are fetched. */
  refresh: unknown;
}) {
  const [data, setData] = useState<TaskSnapshots | null>(null);
  const [page, setPage] = useState<string | null>(null);
  const [size, setSize] = useState<Shot['size']>('desktop');
  const [scheme, setScheme] = useState<'light' | 'dark'>('light');
  const [mode, setMode] = useState<'side' | 'slider'>('side');

  useEffect(() => {
    let live = true;
    void api()
      .projects.snapshots(projectId, taskId)
      .then((d) => live && setData(d))
      .catch(() => live && setData({ after: null, before: null }));
    return () => {
      live = false;
    };
  }, [projectId, taskId, refresh]);

  const after = data?.after;
  if (!after || !after.shots.length) return null;
  // A page as it loads, and each sample state it was shot in ("/ (with cards)").
  const place = (s: Shot) => (s.state ? `${s.page} (${s.state})` : s.page);
  const pages = [...new Set(after.shots.map(place))];
  const current = page && pages.includes(page) ? page : pages[0]!;
  const pick = (set: SnapshotSet | null | undefined) =>
    set?.shots.find((s) => place(s) === current && s.size === size && s.view.scheme === scheme);
  const shot = pick(after);
  const was = pick(data.before);
  const diff = shot && after.diff?.find((d) => d.name === shot.name);
  const label = `${current}, ${size}, ${scheme}`;
  const checks = after.checks;

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-2">
        {pages.length > 1 && (
          <Segmented
            size="sm"
            label="Page"
            value={current}
            onChange={setPage}
            options={pages.map((p) => ({ value: p, label: p }))}
          />
        )}
        <Segmented
          size="sm"
          label="Size"
          value={size}
          onChange={setSize}
          options={[
            { value: 'desktop', label: 'Desktop' },
            { value: 'phone', label: 'Phone' },
          ]}
        />
        <Segmented
          size="sm"
          label="Theme"
          value={scheme}
          onChange={setScheme}
          options={[
            { value: 'light', label: 'Light' },
            { value: 'dark', label: 'Dark' },
          ]}
        />
        {was && (
          <Segmented
            size="sm"
            label="Compare"
            value={mode}
            onChange={setMode}
            options={[
              { value: 'side', label: 'Side by side' },
              { value: 'slider', label: 'Slider' },
            ]}
          />
        )}
      </div>

      {!shot ? (
        <p className="text-[12.5px] text-muted">No screenshot at this size and theme.</p>
      ) : was && mode === 'slider' ? (
        <Slider before={was.path} after={shot.path} label={label} />
      ) : was ? (
        <div className={`grid gap-2 ${size === 'phone' ? 'grid-cols-2' : 'grid-cols-1'}`}>
          <figure>
            <figcaption className="mb-1 text-[11.5px] text-faint">
              Before (merged so far)
            </figcaption>
            <ShotImage path={was.path} alt={`Before: ${label}`} />
          </figure>
          <figure>
            <figcaption className="mb-1 text-[11.5px] text-faint">After this task</figcaption>
            <ShotImage path={shot.path} alt={`After: ${label}`} boxes={diff?.boxes} />
          </figure>
        </div>
      ) : (
        <div className={size === 'phone' ? 'w-1/2' : ''}>
          <ShotImage path={shot.path} alt={label} />
        </div>
      )}

      {shot && (
        <p className="text-[11.5px] text-faint">
          {diff
            ? diff.changed > 0.001
              ? `${(diff.changed * 100).toFixed(diff.changed < 0.1 ? 1 : 0)}% of this screen changed${diff.boxes.length ? ', outlined' : ''}.`
              : 'This screen did not change.'
            : was
              ? ''
              : 'The first screenshots of this page; nothing to compare with yet.'}
          {shot.consoleErrors.length > 0 &&
            ` ${shot.consoleErrors.length} console error${shot.consoleErrors.length === 1 ? '' : 's'}.`}
        </p>
      )}

      {checks && (checks.sendBack.length > 0 || checks.notes.length > 0) && (
        <ul className="flex flex-col gap-1 text-[12.5px]">
          {checks.sendBack.map((c, i) => (
            <li key={`s${i}`} className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-danger" aria-hidden />
              <span className="selectable">{c}</span>
            </li>
          ))}
          {checks.notes.map((c, i) => (
            <li key={`n${i}`} className="flex items-start gap-2 text-muted">
              <Info className="mt-0.5 size-3.5 shrink-0 text-faint" aria-hidden />
              <span className="selectable">{c}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export interface VisualIssueLine extends VisualIssue {
  /** The whole line, as the builder gets it. */
  line: string;
}

/** The "- issue [label (region …): path]" lines of a visual review. */
export function parseVisualIssues(detail: string): VisualIssueLine[] {
  return detail
    .split('\n')
    .filter((l) => l.startsWith('- '))
    .map((l) => {
      const line = l.slice(2).trim();
      return { line, ...parseVisualIssue(line) };
    })
    .filter((v) => v.issue);
}

/**
 * Each visual problem a reviewer found, on the screenshot it was seen in: phone shots side by
 * side, desktop shots full width. `withText` repeats the issue when no checklist shows it.
 */
export function VisualIssues({
  issues,
  withText,
}: {
  issues: VisualIssueLine[];
  withText: boolean;
}) {
  const seen = issues.filter((v) => v.path);
  if (!seen.length) return null;
  return (
    <ul className="grid grid-cols-2 gap-3">
      {seen.map((v, i) => (
        <li key={i} className={/\bphone\b/.test(v.shot ?? '') ? '' : 'col-span-2'}>
          <p className="selectable mb-1 text-[11.5px] text-faint">
            {withText && <span className="block text-[12.5px] text-ink">{v.issue}</span>}
            Seen in {v.shot}
          </p>
          <ShotImage
            path={v.path!}
            alt={`${v.shot}: ${v.issue}`}
            boxes={v.box ? [v.box] : []}
            tone="danger"
          />
        </li>
      ))}
    </ul>
  );
}
