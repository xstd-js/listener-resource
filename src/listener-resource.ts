import { type Abortable, abortify } from '@xstd/abortable';
import { type None, NONE } from '@xstd/none';
import { EdgeQueuingPolicy, type HavingOptionalQueueingPolicy, Queue } from '@xstd/queueing-policy';
import { CloseStack, type OnCloseResource, Resource } from '@xstd/resource';

/**
 * A function called by a `ListenerResource` to broadcast a value to all the registered listeners.
 *
 * @template GValue - The type of the emitted values.
 * @throws {Error} If the resource is closed.
 */
export interface EmitValue<GValue> {
  (value: GValue): void;
}

/**
 * Initializes a `ListenerResource`.
 *
 * Called once, synchronously, by the `ListenerResource` constructor.
 *
 * @template GValue - The type of the emitted values.
 * @param {EmitValue<GValue>} emit - A function to broadcast values to the registered listeners. Throws an error when the resource is closed.
 * @returns {OnCloseResource | void} An optional teardown function invoked with the close reason when the resource closes.
 */
export interface InitListenerResource<GValue> {
  (emit: EmitValue<GValue>): OnCloseResource | void;
}

/**
 * Options of the `ListenerResource.iterator` method.
 *
 * `signal` is an optional `AbortSignal` to stop the iteration.
 * `queueingPolicy` controls the buffering of the values emitted while the consumer is busy processing the previous one, and defaults to `EdgeQueuingPolicy`.
 */
export interface ListenerResourceTOIteratorOptions
  extends Abortable, HavingOptionalQueueingPolicy {}

/**
 * A broadcast hub: values emitted by the source are delivered synchronously, in registration order, to all the registered listeners.
 *
 * - Listeners are registered with `listen`, mirroring `EventTarget.addEventListener` semantics: they are unregistered when their provided `AbortSignal` aborts.
 * - The dispatch is fail-fast: when a listener throws, the remaining listeners are not invoked and the error is rethrown to the emitter.
 * - Closing the resource clears all the registered listeners.
 * - Emitting a value after the resource is closed throws an error.
 *
 * @template GValue - The type of the emitted values.
 * @example
 * ```ts
 * const resource = new ListenerResource<number>((emit) => {
 *   const interval: ReturnType<typeof setInterval> = setInterval((): void => emit(Date.now()), 1000);
 *   return (): void => clearInterval(interval); // teardown, invoked with the close reason on close
 * });
 *
 * const controller: AbortController = new AbortController();
 * resource.listen((value: number): void => console.log(value), { signal: controller.signal });
 *
 * for await (const value of resource) {
 *   if (value > LIMIT) break; // the internal listener is unregistered automatically
 * }
 *
 * await resource.close();
 * ```
 */
export class ListenerResource<GValue> extends Resource {
  readonly #closeStack: CloseStack;
  readonly #listeners: EmitValue<GValue>[];
  #cleanupScheduled: boolean;

  /**
   * Creates a new `ListenerResource`.
   *
   * @param {InitListenerResource<GValue>} init - Called synchronously with the `emit` function. The returned `OnCloseResource`, if any, is registered as a teardown and invoked when the resource closes.
   * @throws {unknown} The error thrown by `init`, if any.
   */
  constructor(init: InitListenerResource<GValue>) {
    super((reason: unknown): Promise<void> => {
      this.#listeners.length = 0;
      return this.#closeStack.close(reason);
    });
    this.#closeStack = new CloseStack(this);
    this.#listeners = [];
    this.#cleanupScheduled = false;
    const onClose: OnCloseResource | void = init(this.#emit.bind(this));
    if (onClose !== undefined) {
      this.#closeStack.addTeardown(onClose);
    }
  }

  #scheduleCleanup(): void {
    if (!this.#cleanupScheduled) {
      this.#cleanupScheduled = true;
      queueMicrotask((): void => {
        this.#cleanupScheduled = false;

        let write: number = 0;
        for (let read: number = 0; read < this.#listeners.length; read++) {
          const listener: EmitValue<GValue> = this.#listeners[read];
          if (listener !== NOOP) {
            this.#listeners[write++] = listener;
          }
        }
        this.#listeners.length = write;
      });
    }
  }

  #emit(value: GValue): void {
    this.throwIfClosed();

    for (let i: number = 0; i < this.#listeners.length; i++) {
      this.#listeners[i](value);
    }
  }

  /**
   * Registers a listener invoked each time a value is emitted.
   *
   * Mirrors `EventTarget.addEventListener` semantics: the listener is unregistered when the provided `signal` aborts.
   * Registering the same listener multiple times registers it multiple times.
   * Registering a listener with an already aborted `signal` does nothing.
   *
   * @param {EmitValue<GValue>} listener - The listener to register.
   * @param {Abortable} [options] - The registration options.
   * @param {AbortSignal} options.signal - An optional `AbortSignal` to unregister the listener.
   * @throws {Error} If the resource is closed.
   */
  listen(listener: EmitValue<GValue>, { signal }: Abortable = {}): void {
    this.throwIfClosed();

    if (signal?.aborted) {
      return;
    }

    this.#listeners.push(listener);

    signal?.addEventListener(
      'abort',
      (): void => {
        this.#listeners[this.#listeners.indexOf(listener)] = NOOP;
        this.#scheduleCleanup();
      },
      {
        once: true,
        signal: this.closeSignal,
      },
    );
  }

  /**
   * Resolves with the next emitted value.
   *
   * The returned promise is tied to this resource's lifecycle: it rejects as soon as the provided `signal` aborts or the resource closes, with the corresponding reason.
   *
   * @param {Abortable} [options] - The waiting options.
   * @param {AbortSignal} options.signal - An optional `AbortSignal` to stop waiting.
   * @returns {Promise<GValue>} A promise resolving with the next emitted value.
   */
  next(options?: Abortable): Promise<GValue> {
    return this.#closeStack.runTask((signal: AbortSignal): Promise<GValue> => {
      return new Promise<GValue>(
        (resolve: (value: GValue) => void, reject: (reason?: any) => void): void => {
          this.listen(
            (value: GValue): void => {
              resolve(value);
            },
            { signal },
          );

          signal.addEventListener(
            'abort',
            (): void => {
              reject(signal.reason);
            },
            { once: true },
          );
        },
      );
    }, options);
  }

  /**
   * Iterates over the emitted values.
   *
   * Values are buffered according to the `queueingPolicy`: with the default `EdgeQueuingPolicy`, values emitted while the consumer is busy processing the previous one are dropped.
   *
   * The internal listener is unregistered when the iteration ends early (e.g. `break`), when the provided `signal` aborts, or when the resource closes.
   *
   * @param {ListenerResourceTOIteratorOptions} [options] - The iteration options.
   * @param {AbortSignal} options.signal - An optional `AbortSignal` to stop the iteration.
   * @param {QueueingPolicy} options.queueingPolicy - The queueing policy applied to the emitted values (defaults to `EdgeQueuingPolicy`).
   * @returns {AsyncGenerator<GValue>} An async generator yielding the emitted values.
   * @throws {unknown} If the provided `signal` or the resource's close signal is already aborted, rejects the signal's reason.
   */
  async *iterator({
    signal,
    queueingPolicy = EdgeQueuingPolicy,
  }: ListenerResourceTOIteratorOptions = {}): AsyncGenerator<GValue> {
    const sharedSignal: AbortSignal =
      signal === undefined ? this.closeSignal : AbortSignal.any([signal, this.closeSignal]);

    sharedSignal.throwIfAborted();

    const queue: Queue<GValue> = queueingPolicy.create<GValue>();
    let promiseWithResolvers: PromiseWithResolvers<void> | undefined;

    const controller: AbortController = new AbortController();

    try {
      this.listen(
        (value: GValue): void => {
          queue.enqueue(value);
          if (promiseWithResolvers !== undefined) {
            promiseWithResolvers.resolve();
            promiseWithResolvers = undefined;
          }
        },
        { signal: AbortSignal.any([sharedSignal, controller.signal]) },
      );

      while (true) {
        const value: GValue | None = queue.dequeue();

        if (value === NONE) {
          promiseWithResolvers = Promise.withResolvers<void>();
          await abortify(promiseWithResolvers.promise, { signal: sharedSignal });
        } else {
          yield value;
        }
      }
    } finally {
      controller.abort();
    }
  }

  /**
   * Enables `for await...of` iteration over this resource.
   *
   * @returns {AsyncGenerator<GValue>} A new async generator, equivalent to `this.iterator()`.
   */
  [Symbol.asyncIterator](): AsyncGenerator<GValue> {
    return this.iterator();
  }
}

/* INTERNAL */

const NOOP = () => {};
