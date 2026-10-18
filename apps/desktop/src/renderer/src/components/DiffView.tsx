import { memo, useMemo, useState } from 'react';
import { ChevronRight, FileCode2 } from 'lucide-react';

interface Line {
  kind: 'add' | 'del' | 'ctx' | 'hunk' | 'meta';
  text: string;
  old?: number;
  new?: number;
}

interface FileDiff {
  path: string;
  status: 'added' | 'deleted' | 'modified' | 'renamed';
  adds: number;
  dels: number;
  lines: Line[];
  binary: boolean;
}

export function parseDiff(diff: string): FileDiff[] {
  const files: FileDiff[] = [];
  let file: FileDiff | undefined;
  let oldNo = 0;
  let newNo = 0;
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      const m = / b\/(.+)$/.exec(raw);
      file = {
        path: m?.[1] ?? raw.slice(11),
        status: 'modified',
        adds: 0,
        dels: 0,
        lines: [],
        binary: false,
      };
      files.push(file);
      continue;
    }
    if (!file) continue;
    if (raw.startsWith('new file mode')) file.status = 'added';
    else if (raw.startsWith('deleted file mode')) file.status = 'deleted';
    else if (raw.startsWith('rename to ')) {
      file.status = 'renamed';
      file.path = raw.slice('rename to '.length);
    } else if (raw.startsWith('Binary files')) file.binary = true;
    else if (raw.startsWith('@@')) {
      const m = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)/.exec(raw);
      oldNo = Number(m?.[1] ?? 0);
      newNo = Number(m?.[2] ?? 0);
      file.lines.push({ kind: 'hunk', text: m?.[3]?.trim() ?? '' });
    } else if (raw.startsWith('+++') || raw.startsWith('---') || raw.startsWith('index ')) {
      continue;
    } else if (raw.startsWith('+')) {
      file.adds++;
      file.lines.push({ kind: 'add', text: raw.slice(1), new: newNo++ });
    } else if (raw.startsWith('-')) {
      file.dels++;
      file.lines.push({ kind: 'del', text: raw.slice(1), old: oldNo++ });
    } else if (raw.startsWith(' ')) {
      file.lines.push({ kind: 'ctx', text: raw.slice(1), old: oldNo++, new: newNo++ });
    } else if (raw.startsWith('\\')) {
      file.lines.push({ kind: 'meta', text: raw.slice(2) });
    }
  }
  return files;
}

const STATUS_TAG: Record<FileDiff['status'], { label: string; className: string }> = {
  added: { label: 'New', className: 'bg-ok-soft text-ok' },
  deleted: { label: 'Deleted', className: 'bg-danger-soft text-danger' },
  modified: { label: '', className: '' },
  renamed: { label: 'Renamed', className: 'bg-accent-soft text-accent-ink' },
};

export const DiffView = memo(function DiffView({ diff }: { diff: string }) {
  const files = useMemo(() => parseDiff(diff), [diff]);
  if (!files.length) return <p className="text-[13px] text-muted">No changes to show.</p>;
  const adds = files.reduce((n, f) => n + f.adds, 0);
  const dels = files.reduce((n, f) => n + f.dels, 0);
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center gap-2 text-[12.5px] text-muted">
        <span>
          {files.length} file{files.length === 1 ? '' : 's'} changed
        </span>
        <span className="font-medium text-ok tabular-nums">+{adds}</span>
        <span className="font-medium text-danger tabular-nums">−{dels}</span>
      </div>
      {files.map((f) => (
        <FileBlock key={f.path} file={f} defaultOpen={files.length <= 6} />
      ))}
    </div>
  );
});

function FileBlock({ file, defaultOpen }: { file: FileDiff; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const tag = STATUS_TAG[file.status];
  const total = file.adds + file.dels || 1;
  return (
    <section className="overflow-hidden rounded-xl border border-line">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 bg-sunken/70 px-3 py-2 text-left text-[12.5px] hover:bg-sunken"
      >
        <ChevronRight
          className={`size-3.5 shrink-0 text-faint transition ${open ? 'rotate-90' : ''}`}
        />
        <FileCode2 className="size-3.5 shrink-0 text-muted" aria-hidden />
        <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{file.path}</span>
        {tag.label && (
          <span className={`rounded-md px-1.5 text-[11px] font-medium ${tag.className}`}>
            {tag.label}
          </span>
        )}
        <span className="font-medium text-ok tabular-nums">+{file.adds}</span>
        <span className="font-medium text-danger tabular-nums">−{file.dels}</span>
        <span className="flex h-1.5 w-12 overflow-hidden rounded-full bg-line" aria-hidden>
          <span className="h-full bg-ok" style={{ width: `${(file.adds / total) * 100}%` }} />
          <span className="h-full bg-danger" style={{ width: `${(file.dels / total) * 100}%` }} />
        </span>
      </button>
      {open && (
        <div className="selectable overflow-x-auto bg-panel font-mono text-[12px] leading-[1.6]">
          {file.binary ? (
            <p className="px-4 py-3 font-sans text-muted">Binary file</p>
          ) : (
            <table className="w-full border-collapse">
              <tbody>
                {file.lines.map((l, i) =>
                  l.kind === 'hunk' ? (
                    <tr key={i} className="bg-accent-soft/60 text-accent-ink">
                      <td colSpan={3} className="px-3 py-0.5 text-[11.5px]">
                        {l.text || '···'}
                      </td>
                    </tr>
                  ) : (
                    <tr
                      key={i}
                      className={
                        l.kind === 'add'
                          ? 'bg-[color-mix(in_srgb,var(--ok)_10%,transparent)]'
                          : l.kind === 'del'
                            ? 'bg-[color-mix(in_srgb,var(--danger)_10%,transparent)]'
                            : ''
                      }
                    >
                      <td className="w-10 px-2 text-right text-faint select-none tabular-nums">
                        {l.old ?? ''}
                      </td>
                      <td className="w-10 px-2 text-right text-faint select-none tabular-nums">
                        {l.new ?? ''}
                      </td>
                      <td className="pr-4 whitespace-pre">
                        <span
                          className={`mr-2 inline-block w-2 select-none ${
                            l.kind === 'add'
                              ? 'text-ok'
                              : l.kind === 'del'
                                ? 'text-danger'
                                : 'text-faint'
                          }`}
                        >
                          {l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' '}
                        </span>
                        {l.kind === 'meta' ? <em className="text-faint">{l.text}</em> : l.text}
                      </td>
                    </tr>
                  ),
                )}
              </tbody>
            </table>
          )}
        </div>
      )}
    </section>
  );
}
