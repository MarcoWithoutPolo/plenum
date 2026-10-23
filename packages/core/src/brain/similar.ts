/**
 * Telling whether two task titles describe the same piece of work, so a failed
 * task and the planner's later re-proposal count as one task, not two.
 */

const STOPWORDS = new Set(
  'a an and the to of in on for with by from into onto at as is are be it its this that every each all any add make create implement build use support new'.split(
    ' ',
  ),
);

/** Content words of a title: lowercased, punctuation split, stopwords and plural "s" dropped. */
export function titleWords(title: string): Set<string> {
  const words = title
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !STOPWORDS.has(w))
    .map((w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w));
  return new Set(words);
}

/**
 * Overlap coefficient of the content words: shared / size of the smaller set.
 * Two titles are the same work when they share at least two content words and half of the shorter one.
 */
export function titleSimilarity(a: string, b: string): { shared: number; score: number } {
  const wa = titleWords(a);
  const wb = titleWords(b);
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared++;
  const smaller = Math.min(wa.size, wb.size);
  return { shared, score: smaller ? shared / smaller : 0 };
}

export function sameWork(a: string, b: string): boolean {
  const { shared, score } = titleSimilarity(a, b);
  return shared >= 2 && score >= 0.5;
}

/** The candidate most likely to be a redo of `title`, if any is close enough. */
export function findReplacement<T extends { title: string }>(
  title: string,
  candidates: T[],
): T | undefined {
  let best: { item: T; score: number } | undefined;
  for (const item of candidates) {
    if (!sameWork(title, item.title)) continue;
    const { score } = titleSimilarity(title, item.title);
    if (!best || score > best.score) best = { item, score };
  }
  return best?.item;
}
