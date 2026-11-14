/** Signals joined into one, and a way to let go of them. */
export interface LinkedSignal {
  signal: AbortSignal;
  /** Stop listening to the sources. Call it when the work the signal guards is over. */
  dispose: () => void;
}

/**
 * Join signals: the result aborts when any of them does, with its reason. Unlike
 * `AbortSignal.any()`, nothing is kept once `dispose()` is called. Node keeps every
 * `AbortSignal.any()` result alive as long as its sources live, so joining a per-step signal to a
 * project's signal grew memory with every step of a project that runs for days.
 */
export function linkSignals(...sources: (AbortSignal | undefined)[]): LinkedSignal {
  const live = sources.filter((s): s is AbortSignal => Boolean(s));
  const controller = new AbortController();
  const already = live.find((s) => s.aborted);
  if (already) {
    controller.abort(already.reason);
    return { signal: controller.signal, dispose: () => {} };
  }
  const listeners = live.map((source) => {
    const onAbort = () => {
      dispose();
      controller.abort(source.reason);
    };
    source.addEventListener('abort', onAbort, { once: true });
    return [source, onAbort] as const;
  });
  let disposed = false;
  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const [source, onAbort] of listeners) source.removeEventListener('abort', onAbort);
  }
  return { signal: controller.signal, dispose };
}
