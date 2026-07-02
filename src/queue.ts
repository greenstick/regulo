/*
Queued Task

Encapsulates the lifecycle of a single queued acquire() call.

Terminal paths compete to finalize the task exactly once:
  dispatch  — the scheduler pops the task when a permit opens.
  abort     — the caller's AbortSignal fires (registered here, per task).
  timeout   — the semaphore's shared deadline watchdog claims the task once its
              queueMaxTimeout elapses (not a per-task timer; see Semaphore).
  discard   — bulk teardown (purge / reset / shutdown).

claim() is the one-shot gate shared by all of them. Whichever calls it first
wins; later calls are no-ops. claim() also removes the abort listener, so each
path needs no coordination. The semaphore-level side effects (queue removal,
metrics, events, final Promise settlement) run after a successful claim():
dispatch resolves immediately; the timeout path is staged — the semaphore
claim()s, runs the breaker/metrics side effects, then reject()s.
*/

export class QueuedTask {
  public readonly id: number;
  public readonly priority: number;
  public readonly enqueueTime: number;
  public readonly isProbe: boolean;
  public readonly weight: number;

  // Intrusive links for the semaphore's enqueue-ordered index (see IntrusiveList
  // in ./list). Owned and mutated solely by that list; untouched otherwise.
  public prev: QueuedTask | null = null;
  public next: QueuedTask | null = null;

  // Intrusive slot for the priority heap (see IndexedBinaryHeap in ./heap): this
  // task's position in the heap's backing array, or -1 when not queued. Owned
  // and mutated solely by that heap.
  public heapIndex = -1;

  private completed = false;
  private abortListener?: () => void;
  private readonly abortSignal?: AbortSignal;
  private readonly _resolve: (release: () => void) => void;
  private readonly _reject: (err: Error) => void;

  constructor(config: {
    id: number;
    priority: number;
    enqueueTime: number;
    isProbe: boolean;
    resolve: (release: () => void) => void;
    reject: (err: Error) => void;
    abortSignal?: AbortSignal;
    weight?: number;
  }) {
    this.id = config.id;
    this.priority = config.priority;
    this.enqueueTime = config.enqueueTime;
    this.isProbe = config.isProbe;
    this.weight = config.weight ?? 1;
    this._resolve = config.resolve;
    this._reject = config.reject;
    this.abortSignal = config.abortSignal;
  }

  /**
   * Register the abort handler. Must be called before inserting the task into
   * the queue.
   *
   * The queue-wait timeout is NOT a per-task timer: the semaphore drives it from
   * a single shared deadline timer keyed on the oldest queued task (see
   * Semaphore._armTimeout / _fireTimeout). That keeps the hot enqueue/dispatch
   * path free of a `setTimeout`/`clearTimeout` pair per task. Abort stays
   * per-task because it is event-driven (an `AbortSignal` listener), not polled.
   */
  public arm(onAbort: () => void): void {
    if (this.abortSignal) {
      this.abortListener = () => {
        if (this.claim()) onAbort();
      };
      this.abortSignal.addEventListener('abort', this.abortListener);
    }
  }

  /**
   * Dispatch this task. Called by the scheduler when a permit is available.
   * Returns false if the task was already finalized by timeout or abort.
   */
  public dispatch(createRelease: () => () => void): boolean {
    if (!this.claim()) return false;
    this._resolve(createRelease());
    return true;
  }

  /**
   * Finalize this task externally (purge, shutdown, reset).
   * Returns false if the task was already finalized.
   */
  public discard(err: Error): boolean {
    if (!this.claim()) return false;
    this._reject(err);
    return true;
  }

  /**
   * Atomically claim this task (one-shot); removes the abort listener on the
   * winning call and returns false if some other terminal path got there first.
   *
   * Public so the semaphore's shared timeout timer can claim a task, run the
   * timeout side effects, then reject() it — a staged variant of discard().
   */
  public claim(): boolean {
    if (this.completed) return false;
    this.completed = true;
    if (this.abortSignal && this.abortListener) {
      this.abortSignal.removeEventListener('abort', this.abortListener);
    }
    return true;
  }


  /** Reject this task's promise. The caller must have won claim() first. */
  public reject(err: Error): void { this._reject(err); }
}
