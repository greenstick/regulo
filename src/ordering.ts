/*
Queue Ordering

Encapsulates how queued tasks are ordered for dispatch. Priority is always the
primary key (lower priority value dispatches first); an ordering decides how to
break ties among equal-priority tasks.

Two layers:
  QUEUE_ORDERINGS  — named presets ('fifo' | 'lifo') keyed for the `queueOrder`
                     config option.
  buildComparator  — resolves the configured ordering (named preset or a custom
                     `comparator`) and wraps it so probe tasks always sort first.

The probe-first wrapper is a hard invariant, not a preset detail: the half-open
scheduler dispatches only the task whose id matches the in-flight probe, and it
inspects the heap head to find it. If a custom comparator (or 'lifo') placed the
probe behind other queued tasks, the probe would never reach the head and the
circuit could never close. Forcing probes first here means a custom comparator
never has to know probes exist.
*/

import type { Comparator, QueueOrder, QueuedTaskView } from './types';

/** Built-in orderings, keyed by `queueOrder`. Each keeps priority primary. */
export const QUEUE_ORDERINGS: Record<QueueOrder, Comparator<QueuedTaskView>> = {
  // Earliest-enqueued first (stable, head-of-line fair) with priority.
  fifo: (a, b) => (a.priority - b.priority) || (a.id - b.id),
  // Latest-enqueued first with priority.
  lifo: (a, b) => (a.priority - b.priority) || (b.id - a.id),
  // Earliest-enqueued first (stable, head-of-line fair) without priority.
  fifoIgnorePriority: (a, b) => (a.id - b.id),
  // Latest-enqueued first without priority.
  lifoIgnorePriority: (a, b) => (b.id - a.id),
};

export interface OrderingConfig {
  queueOrder?: QueueOrder;
  comparator?: Comparator<QueuedTaskView>;
}

/** Minimal shape the heap comparator operates on. */
interface OrderableTask extends QueuedTaskView {
  readonly isProbe: boolean;
}

/**
 * Resolve the user-facing comparator: an explicit `comparator` wins over a
 * named `queueOrder`, which defaults to 'fifo'. Throws on an invalid value so
 * misconfiguration fails fast at construction.
 */
export function resolveComparator(config: OrderingConfig): Comparator<QueuedTaskView> {
  if (config.comparator !== undefined) {
    if (typeof config.comparator !== 'function') {
      throw new Error('Semaphore comparator must be a function');
    }
    return config.comparator;
  }
  const order = config.queueOrder ?? 'fifo';
  const cmp = QUEUE_ORDERINGS[order];
  if (cmp === undefined) {
    throw new Error(
      `Semaphore queueOrder must be one of: ${Object.keys(QUEUE_ORDERINGS).join(', ')} (got ${JSON.stringify(order)})`
    );
  }
  return cmp;
}

/**
 * Build the heap comparator from config, wrapped so probe tasks always sort
 * ahead of non-probe tasks regardless of the configured ordering.
 *
 * The wrapper also sanitizes the result of the (possibly user-supplied)
 * ordering: a binary heap relies on a consistent total order, and a comparator
 * that returns `NaN` (e.g. from a non-finite `priority`) or a non-number (a
 * comparator that forgets to return a value) would silently corrupt the heap's
 * structure. Any such result is replaced with a stable `id` tie-break, so a
 * misbehaving comparator degrades to FIFO instead of breaking dispatch.
 */
export function buildComparator<T extends OrderableTask>(config: OrderingConfig): Comparator<T> {
  const order = resolveComparator(config);
  return (a, b) => {
    if (a.isProbe !== b.isProbe) return a.isProbe ? -1 : 1;
    const result = order(a, b);
    if (typeof result !== 'number' || Number.isNaN(result)) return a.id - b.id;
    return result;
  };
}
