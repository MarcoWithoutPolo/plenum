/** A region of a screenshot, in that image's pixels: [x1, y1, x2, y2]. */
export type ShotBox = [number, number, number, number];

/** One problem a reviewer saw in a screenshot, as the builder and the app get it. */
export interface VisualIssue {
  issue: string;
  /** The screenshot's label, like "after: / (phone, dark)". */
  shot?: string;
  box?: ShotBox;
  /** The screenshot file, when the label matched one the reviewer was shown. */
  path?: string;
}

/** "issue [label (region x1, y1, x2, y2): path]", one line, without the list dash. */
export function visualIssueLine(v: VisualIssue): string {
  if (!v.shot) return v.issue;
  const where = v.box ? ` (region ${v.box.join(', ')})` : '';
  return `${v.issue} [${v.shot}${where}${v.path ? `: ${v.path}` : ''}]`;
}

/**
 * Reads a line written by visualIssueLine back. Labels contain ": " ("after: /") and paths can
 * contain spaces, so the path is what follows the last ": " when it ends in ".png".
 */
export function parseVisualIssue(line: string): VisualIssue {
  // Labels Conclave gave start with "after:" or "before:"; anything else is the reviewer's own.
  const m =
    /^(.*) \[((?:after|before): .+)\]$/s.exec(line.trim()) ?? /^(.*?) \[(.+)\]$/s.exec(line.trim());
  if (!m) return { issue: line.trim() };
  let inner = m[2]!;
  let path: string | undefined;
  const cut = inner.lastIndexOf(': ');
  if (cut > 0 && /\.png$/i.test(inner)) {
    const tail = inner.slice(cut + 2);
    // A label's own ": " comes before the page; a path never has a "(region" before it.
    if (!/\(region /.test(tail) && /[\\/]/.test(tail)) {
      path = tail;
      inner = inner.slice(0, cut);
    }
  }
  const r = /^(.*) \(region (-?\d+), (-?\d+), (-?\d+), (-?\d+)\)$/.exec(inner);
  return {
    issue: m[1]!,
    shot: r ? r[1]! : inner,
    ...(r && { box: [r[2], r[3], r[4], r[5]].map(Number) as ShotBox }),
    ...(path && { path }),
  };
}
