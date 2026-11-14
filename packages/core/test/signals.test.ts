import { getEventListeners } from 'node:events';
import { describe, expect, it } from 'vitest';
import { linkSignals } from '../src/signals.js';

describe('linkSignals (1.0.1 S2)', () => {
  it('lets go of a long-lived signal once each step is over', () => {
    const project = new AbortController();
    for (let step = 0; step < 10_000; step++) {
      const task = new AbortController();
      const link = linkSignals(project.signal, task.signal);
      link.dispose();
    }
    expect(getEventListeners(project.signal, 'abort')).toHaveLength(0);
  });

  it('aborts when any source aborts, with its reason, and then lets go of the others', () => {
    const project = new AbortController();
    const task = new AbortController();
    const link = linkSignals(project.signal, undefined, task.signal);
    expect(link.signal.aborted).toBe(false);
    task.abort('skipped');
    expect(link.signal.aborted).toBe(true);
    expect(link.signal.reason).toBe('skipped');
    expect(getEventListeners(project.signal, 'abort')).toHaveLength(0);
  });

  it('starts aborted when a source already is', () => {
    const done = new AbortController();
    done.abort('stopped');
    const link = linkSignals(new AbortController().signal, done.signal);
    expect(link.signal.aborted).toBe(true);
    expect(link.signal.reason).toBe('stopped');
  });

  it('with no sources, never aborts', () => {
    expect(linkSignals(undefined).signal.aborted).toBe(false);
  });
});
