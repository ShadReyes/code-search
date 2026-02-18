// A typed event emitter with support for once listeners, async emission,
// wildcard patterns, and listener introspection.

export type EventHandler<T = unknown> = (payload: T) => void | Promise<void>;

export interface ListenerEntry<T = unknown> {
  handler: EventHandler<T>;
  once: boolean;
  priority: number;
  addedAt: number;
  label?: string;
}

export interface EmitterOptions {
  maxListeners: number;
  warnOnLeak: boolean;
  captureRejections: boolean;
}

export interface EmitterStats {
  totalEvents: number;
  totalListeners: number;
  totalEmissions: number;
  eventNames: string[];
}

const DEFAULT_OPTIONS: EmitterOptions = {
  maxListeners: 100,
  warnOnLeak: true,
  captureRejections: false,
};

function matchesWildcard(pattern: string, eventName: string): boolean {
  if (pattern === '*') return true;
  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${regexStr}$`).test(eventName);
}

function sortByPriority<T>(entries: ListenerEntry<T>[]): ListenerEntry<T>[] {
  return [...entries].sort((a, b) => {
    if (a.priority !== b.priority) return b.priority - a.priority;
    return a.addedAt - b.addedAt;
  });
}

function generateListenerId(): string {
  return Math.random().toString(36).substring(2, 10);
}

/**
 * A fully typed event emitter supporting generics, priorities, once-listeners,
 * wildcard subscriptions, async emission, and comprehensive introspection.
 */
export class EventEmitter<EventMap extends Record<string, unknown> = Record<string, unknown>> {
  private _listeners: Map<string, ListenerEntry<any>[]>;
  private _options: EmitterOptions;
  private _emissionCount: number;
  private _paused: boolean;
  private _pendingWhilePaused: Array<{ event: string; payload: unknown }>;
  private _interceptors: Map<string, (payload: any) => any>;

  constructor(options?: Partial<EmitterOptions>) {
    this._listeners = new Map();
    this._options = { ...DEFAULT_OPTIONS, ...options };
    this._emissionCount = 0;
    this._paused = false;
    this._pendingWhilePaused = [];
    this._interceptors = new Map();
  }

  /**
   * Registers an event listener with optional priority and label.
   */
  on<K extends string & keyof EventMap>(
    event: K,
    handler: EventHandler<EventMap[K]>,
    options?: { priority?: number; label?: string }
  ): this {
    const entry: ListenerEntry<EventMap[K]> = {
      handler,
      once: false,
      priority: options?.priority ?? 0,
      addedAt: Date.now(),
      label: options?.label,
    };

    this._addListener(event, entry);
    return this;
  }

  /**
   * Registers a one-time event listener that auto-removes after first invocation.
   */
  once<K extends string & keyof EventMap>(
    event: K,
    handler: EventHandler<EventMap[K]>,
    options?: { priority?: number; label?: string }
  ): this {
    const entry: ListenerEntry<EventMap[K]> = {
      handler,
      once: true,
      priority: options?.priority ?? 0,
      addedAt: Date.now(),
      label: options?.label,
    };

    this._addListener(event, entry);
    return this;
  }

  /**
   * Removes a specific handler for an event.
   */
  off<K extends string & keyof EventMap>(event: K, handler: EventHandler<EventMap[K]>): this {
    const listeners = this._listeners.get(event);
    if (!listeners) return this;

    const filtered = listeners.filter((entry) => entry.handler !== handler);
    if (filtered.length === 0) {
      this._listeners.delete(event);
    } else {
      this._listeners.set(event, filtered);
    }

    return this;
  }

  /**
   * Removes all listeners for a given event, or all listeners entirely.
   */
  removeAllListeners(event?: string & keyof EventMap): this {
    if (event) {
      this._listeners.delete(event);
    } else {
      this._listeners.clear();
    }
    return this;
  }

  /**
   * Synchronously emits an event to all registered listeners.
   */
  emit<K extends string & keyof EventMap>(event: K, payload: EventMap[K]): boolean {
    if (this._paused) {
      this._pendingWhilePaused.push({ event, payload });
      return false;
    }

    const interceptor = this._interceptors.get(event);
    const finalPayload = interceptor ? interceptor(payload) : payload;

    const listeners = this._getMatchingListeners(event);
    if (listeners.length === 0) return false;

    this._emissionCount++;
    const sorted = sortByPriority(listeners);
    const oncesToRemove: EventHandler<any>[] = [];

    for (const entry of sorted) {
      try {
        entry.handler(finalPayload);
      } catch (err) {
        if (this._options.captureRejections) {
          this._handleError(event, err);
        } else {
          throw err;
        }
      }

      if (entry.once) {
        oncesToRemove.push(entry.handler);
      }
    }

    for (const handler of oncesToRemove) {
      this.off(event, handler);
    }

    return true;
  }

  /**
   * Asynchronously emits an event, awaiting each handler in priority order.
   */
  async emitAsync<K extends string & keyof EventMap>(
    event: K,
    payload: EventMap[K]
  ): Promise<boolean> {
    if (this._paused) {
      this._pendingWhilePaused.push({ event, payload });
      return false;
    }

    const interceptor = this._interceptors.get(event);
    const finalPayload = interceptor ? interceptor(payload) : payload;

    const listeners = this._getMatchingListeners(event);
    if (listeners.length === 0) return false;

    this._emissionCount++;
    const sorted = sortByPriority(listeners);
    const oncesToRemove: EventHandler<any>[] = [];

    for (const entry of sorted) {
      try {
        await entry.handler(finalPayload);
      } catch (err) {
        if (this._options.captureRejections) {
          this._handleError(event, err);
        } else {
          throw err;
        }
      }

      if (entry.once) {
        oncesToRemove.push(entry.handler);
      }
    }

    for (const handler of oncesToRemove) {
      this.off(event, handler);
    }

    return true;
  }

  /**
   * Emits to all listeners concurrently using Promise.allSettled.
   */
  async emitConcurrent<K extends string & keyof EventMap>(
    event: K,
    payload: EventMap[K]
  ): Promise<PromiseSettledResult<void>[]> {
    const listeners = this._getMatchingListeners(event);
    if (listeners.length === 0) return [];

    this._emissionCount++;
    const promises = listeners.map((entry) =>
      Promise.resolve(entry.handler(payload)).then(() => {
        if (entry.once) {
          this.off(event as any, entry.handler);
        }
      })
    );

    return Promise.allSettled(promises);
  }

  /**
   * Returns a promise that resolves the next time the given event is emitted.
   */
  waitFor<K extends string & keyof EventMap>(
    event: K,
    timeout?: number
  ): Promise<EventMap[K]> {
    return new Promise((resolve, reject) => {
      let timeoutId: ReturnType<typeof setTimeout> | undefined;

      const handler: EventHandler<EventMap[K]> = (payload) => {
        if (timeoutId) clearTimeout(timeoutId);
        resolve(payload);
      };

      this.once(event, handler);

      if (timeout !== undefined) {
        timeoutId = setTimeout(() => {
          this.off(event, handler);
          reject(new Error(`Timeout waiting for event "${event}" after ${timeout}ms`));
        }, timeout);
      }
    });
  }

  /**
   * Registers an interceptor that transforms payloads before they reach listeners.
   */
  intercept<K extends string & keyof EventMap>(
    event: K,
    transform: (payload: EventMap[K]) => EventMap[K]
  ): this {
    this._interceptors.set(event, transform);
    return this;
  }

  /**
   * Removes an interceptor for a given event.
   */
  removeInterceptor(event: string & keyof EventMap): this {
    this._interceptors.delete(event);
    return this;
  }

  /**
   * Pauses all event emission; events are queued for later replay.
   */
  pause(): this {
    this._paused = true;
    return this;
  }

  /**
   * Resumes event emission and replays any queued events.
   */
  async resume(): Promise<this> {
    this._paused = false;
    const pending = [...this._pendingWhilePaused];
    this._pendingWhilePaused = [];

    for (const { event, payload } of pending) {
      await this.emitAsync(event as any, payload as any);
    }

    return this;
  }

  /**
   * Returns all registered event names.
   */
  eventNames(): string[] {
    return Array.from(this._listeners.keys());
  }

  /**
   * Returns the number of listeners for a given event.
   */
  listenerCount(event: string & keyof EventMap): number {
    return this._listeners.get(event)?.length ?? 0;
  }

  /**
   * Returns raw listener entries for debugging or introspection.
   */
  rawListeners(event: string & keyof EventMap): ListenerEntry[] {
    return [...(this._listeners.get(event) ?? [])];
  }

  /**
   * Returns comprehensive stats about this emitter instance.
   */
  get stats(): EmitterStats {
    let totalListeners = 0;
    for (const entries of this._listeners.values()) {
      totalListeners += entries.length;
    }

    return {
      totalEvents: this._listeners.size,
      totalListeners,
      totalEmissions: this._emissionCount,
      eventNames: this.eventNames(),
    };
  }

  /**
   * Whether the emitter is currently paused.
   */
  get isPaused(): boolean {
    return this._paused;
  }

  /**
   * The configured maximum number of listeners per event.
   */
  get maxListeners(): number {
    return this._options.maxListeners;
  }

  /**
   * Static factory method for creating a typed emitter.
   */
  static create<M extends Record<string, unknown>>(
    options?: Partial<EmitterOptions>
  ): EventEmitter<M> {
    return new EventEmitter<M>(options);
  }

  /**
   * Creates a child emitter that forwards all events to this parent.
   */
  static merge<M extends Record<string, unknown>>(
    ...emitters: EventEmitter<M>[]
  ): EventEmitter<M> {
    const merged = new EventEmitter<M>();

    for (const emitter of emitters) {
      for (const event of emitter.eventNames()) {
        const listeners = emitter.rawListeners(event as any);
        for (const listener of listeners) {
          merged._addListener(event, { ...listener });
        }
      }
    }

    return merged;
  }

  // ---- Private methods ----

  private _addListener<T>(event: string, entry: ListenerEntry<T>): void {
    const existing = this._listeners.get(event) ?? [];

    if (
      this._options.warnOnLeak &&
      existing.length >= this._options.maxListeners
    ) {
      console.warn(
        `Warning: Event "${event}" has ${existing.length} listeners. ` +
          `Possible memory leak. Max is ${this._options.maxListeners}.`
      );
    }

    existing.push(entry);
    this._listeners.set(event, existing);
  }

  private _getMatchingListeners(event: string): ListenerEntry<any>[] {
    const direct = this._listeners.get(event) ?? [];
    const wildcardMatches: ListenerEntry<any>[] = [];

    for (const [pattern, entries] of this._listeners.entries()) {
      if (pattern !== event && pattern.includes('*') && matchesWildcard(pattern, event)) {
        wildcardMatches.push(...entries);
      }
    }

    return [...direct, ...wildcardMatches];
  }

  private _handleError(event: string, error: unknown): void {
    const errorEvent = 'error' as string & keyof EventMap;
    const errorListeners = this._listeners.get(errorEvent);

    if (errorListeners && errorListeners.length > 0) {
      for (const entry of errorListeners) {
        entry.handler({ event, error } as any);
      }
    } else {
      console.error(`Unhandled error in event "${event}":`, error);
    }
  }
}

/**
 * Creates a debounced version of an event handler.
 */
export function debounceHandler<T>(
  handler: EventHandler<T>,
  delayMs: number
): EventHandler<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  return (payload: T) => {
    if (timeoutId) clearTimeout(timeoutId);
    timeoutId = setTimeout(() => handler(payload), delayMs);
  };
}

/**
 * Creates a throttled version of an event handler.
 */
export function throttleHandler<T>(
  handler: EventHandler<T>,
  intervalMs: number
): EventHandler<T> {
  let lastCall = 0;
  let pendingTimeout: ReturnType<typeof setTimeout> | undefined;

  return (payload: T) => {
    const now = Date.now();
    const elapsed = now - lastCall;

    if (elapsed >= intervalMs) {
      lastCall = now;
      handler(payload);
    } else if (!pendingTimeout) {
      pendingTimeout = setTimeout(() => {
        lastCall = Date.now();
        pendingTimeout = undefined;
        handler(payload);
      }, intervalMs - elapsed);
    }
  };
}

/**
 * Pipes events from one emitter to another, optionally transforming payloads.
 */
export function pipeEvents<
  S extends Record<string, unknown>,
  D extends Record<string, unknown>
>(
  source: EventEmitter<S>,
  destination: EventEmitter<D>,
  eventMap: Partial<Record<string & keyof S, string & keyof D>>,
  transform?: (payload: unknown) => unknown
): () => void {
  const cleanups: Array<() => void> = [];

  for (const [sourceEvent, destEvent] of Object.entries(eventMap)) {
    const handler = (payload: unknown) => {
      const transformed = transform ? transform(payload) : payload;
      destination.emit(destEvent as any, transformed as any);
    };

    source.on(sourceEvent as any, handler as any);
    cleanups.push(() => source.off(sourceEvent as any, handler as any));
  }

  return () => {
    for (const cleanup of cleanups) {
      cleanup();
    }
  };
}
