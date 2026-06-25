/*
Queued Task

Encapsulates the lifecycle of a single queued acquire() call.

Three terminal paths compete to finalize the task:
  dispatch  — the scheduler pops the task when a permit opens.
  timeout   — the watchdog timer fires after queueMaxTimeout.
  abort     — the caller's AbortSignal fires.

take() is a one-shot gate shared by all three paths. Whichever fires first
wins; subsequent invocations are no-ops. take() also handles cleanup (clears
the timer and removes the abort listener) so each path needs no coordination.

The onTimeout and onAbort callbacks run after take() succeeds and are
responsible for semaphore-level side effects (queue removal, metrics, events,
and the final Promise rejection).
*/

export class QueuedTask {
  public readonly id: number;
  public readonly priority: number;
  public readonly enqueueTime: number;
  public readonly isProbe: boolean;
  public readonly weight: number;

  private completed = false;
  private timeoutId?: ReturnType<typeof setTimeout>;
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
   * Register the watchdog timer and abort handler. Must be called before
   * inserting the task into the queue.
   */
  public arm(timeoutMs: number, onTimeout: () => void, onAbort: () => void): void {
    this.timeoutId = setTimeout(() => {
      if (this.take()) onTimeout();
    }, timeoutMs);

    if (this.abortSignal) {
      this.abortListener = () => {
        if (this.take()) onAbort();
      };
      this.abortSignal.addEventListener('abort', this.abortListener);
    }
  }

  /**
   * Dispatch this task. Called by the scheduler when a permit is available.
   * Returns false if the task was already finalized by timeout or abort.
   */
  public dispatch(createRelease: () => () => void): boolean {
    if (!this.take()) return false;
    this._resolve(createRelease());
    return true;
  }

  /**
   * Finalize this task externally (purge, shutdown, reset).
   * Returns false if the task was already finalized.
   */
  public discard(err: Error): boolean {
    if (!this.take()) return false;
    this._reject(err);
    return true;
  }

  /** Claim this task atomically. Clears timer and abort listener on success. */
  private take(): boolean {
    if (this.completed) return false;
    this.completed = true;
    if (this.timeoutId !== undefined) {
      clearTimeout(this.timeoutId);
      this.timeoutId = undefined;
    }
    if (this.abortSignal && this.abortListener) {
      this.abortSignal.removeEventListener('abort', this.abortListener);
    }
    return true;
  }
}

/*
Queue Age Cache

Lazily-updated cache of the oldest enqueue time in the queue.
- Insert is O(1) (min check only; new tasks are never older than existing ones).
- Read is O(1) when clean, O(N) when dirty (after any removal).
- Invalidated after any removal that may have evicted the oldest task.
*/

export class QueueAgeCache {
  private _oldest = 0;

  public onInsert(enqueueTime: number): void {
    if (this._oldest === 0 || enqueueTime < this._oldest) {
      this._oldest = enqueueTime;
    }
  }

  public invalidate(): void {
    this._oldest = 0;
  }

  public ageMs(tasks: QueuedTask[]): number {
    if (tasks.length === 0) return 0;
    if (this._oldest !== 0) return Date.now() - this._oldest;
    let oldest = Infinity;
    for (const task of tasks) {
      if (task.enqueueTime < oldest) oldest = task.enqueueTime;
    }
    this._oldest = oldest === Infinity ? 0 : oldest;
    return this._oldest === 0 ? 0 : Date.now() - this._oldest;
  }

  public reset(): void {
    this._oldest = 0;
  }
}
