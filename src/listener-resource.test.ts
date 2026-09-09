import { NONE } from '@xstd/none';
import { Queue, QueueingPolicy } from '@xstd/queueing-policy';
import { CloseStack } from '@xstd/resource';
import { describe, expect, it } from 'vitest';
import { type EmitValue, ListenerResource } from './listener-resource.ts';

class RecordingPolicy extends QueueingPolicy {
  readonly #enqueued: unknown[] = [];

  constructor() {
    super(<GV>(): Queue<GV> => {
      const state: { pending: GV | undefined; step: 0 | 1 | 2 } = { pending: undefined, step: 0 };
      return new Queue<GV>({
        enqueue: (value: GV): void => {
          this.#enqueued.push(value);
          if (state.step === 1) {
            state.pending = value;
            state.step = 2;
          }
        },
        dequeue: (): GV | typeof NONE => {
          if (state.step === 2) {
            state.step = 0;
            return state.pending as GV;
          }
          if (state.step === 0) {
            state.step = 1;
          }
          return NONE;
        },
      });
    });
  }

  get enqueued(): readonly unknown[] {
    return this.#enqueued;
  }
}

const setImmediateAsync = (): Promise<void> =>
  new Promise<void>((resolve) => setImmediate(resolve));

describe('ListenerResource', () => {
  it('delivers emitted values to listeners', async () => {
    let emit!: EmitValue<number>;
    const resource = new ListenerResource<number>((emitFunction: EmitValue<number>): void => {
      emit = emitFunction;
    });

    const received: number[] = [];
    resource.listen((value: number): void => {
      received.push(value);
    });

    emit(1);
    emit(2);

    expect(received).toEqual([1, 2]);

    await resource.close();
  });

  it('listen() throws when the resource is closed', async () => {
    const resource = new ListenerResource<number>((): void => {});

    await resource.close();

    expect((): void => {
      resource.listen((_: number): void => {});
    }).toThrowError('Resource closed');
  });

  it('emit() throws when the resource is closed', async () => {
    let emit!: EmitValue<number>;
    const resource = new ListenerResource<number>((emitFunction: EmitValue<number>): void => {
      emit = emitFunction;
    });

    await resource.close();

    expect((): void => {
      emit(1);
    }).toThrowError('Resource closed');
  });

  it('listen() is a no-op when the provided signal is already aborted', () => {
    const resource = new ListenerResource<number>((): void => {});

    const controller: AbortController = new AbortController();
    controller.abort();

    expect((): void => {
      resource.listen((_: number): void => {}, { signal: controller.signal });
    }).not.toThrow();
  });

  it('stops dispatching and rethrows when a listener throws', async () => {
    let emit!: EmitValue<number>;
    const resource = new ListenerResource<number>((emitFunction: EmitValue<number>): void => {
      emit = emitFunction;
    });

    const sentinel: Error = new Error('listener failed');
    const calls: string[] = [];

    resource.listen((_: number): void => {
      calls.push('a');
      throw sentinel;
    });
    resource.listen((_: number): void => {
      calls.push('b');
    });

    let thrown: unknown;
    try {
      emit(1);
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toBe(sentinel);
    expect(calls).toEqual(['a']);

    await resource.close();
  });

  it('stops delivering to a listener after its signal aborts, without disturbing other listeners', async () => {
    let emit!: EmitValue<number>;
    const resource = new ListenerResource<number>((emitFunction: EmitValue<number>): void => {
      emit = emitFunction;
    });

    const removed: number[] = [];
    const kept: number[] = [];

    const controller: AbortController = new AbortController();
    resource.listen(
      (value: number): void => {
        removed.push(value);
      },
      { signal: controller.signal },
    );
    resource.listen((value: number): void => {
      kept.push(value);
    });

    emit(1);
    expect(removed).toEqual([1]);
    expect(kept).toEqual([1]);

    controller.abort();
    emit(2);
    expect(removed).toEqual([1]);
    expect(kept).toEqual([1, 2]);

    await setImmediateAsync();

    emit(3);
    expect(removed).toEqual([1]);
    expect(kept).toEqual([1, 2, 3]);

    await resource.close();
  });

  it('next() resolves with the next emitted value', async () => {
    let emit!: EmitValue<number>;
    const resource = new ListenerResource<number>((emitFunction: EmitValue<number>): void => {
      emit = emitFunction;
    });

    const promise: Promise<number> = resource.next();
    emit(42);

    await expect(promise).resolves.toBe(42);

    await resource.close();
  });

  it('runs the teardown returned by init on close, with the close reason', async () => {
    let closedWithReason: unknown;

    const resource = new ListenerResource<number>((): OnCloseLike => {
      return (reason: unknown): void => {
        closedWithReason = reason;
      };
    });

    expect(closedWithReason).toBeUndefined();

    await resource.close('because');

    expect(closedWithReason).toBe('because');
  });

  it('removes the iterator listener when iteration ends early', async () => {
    let emit!: EmitValue<number>;
    const resource = new ListenerResource<number>((emitFunction: EmitValue<number>): void => {
      emit = emitFunction;
    });

    const policy = new RecordingPolicy();
    const iterator: AsyncIterator<number> = resource
      .iterator({ queueingPolicy: policy })
      [Symbol.asyncIterator]();

    const first: Promise<IteratorResult<number>> = iterator.next();
    emit(1);
    expect((await first).value).toBe(1);

    const second: Promise<IteratorResult<number>> = iterator.next();
    emit(2);
    expect((await second).value).toBe(2);

    const before: number = policy.enqueued.length;
    expect(before).toBeGreaterThan(0);

    await iterator.return?.();

    emit(3);
    emit(4);
    await setImmediateAsync();

    expect(policy.enqueued).toEqual(policy.enqueued.slice(0, before));

    await resource.close();
  });

  it('iterator() resolves a pending next() when a value is emitted', async () => {
    let emit!: EmitValue<number>;
    const resource = new ListenerResource<number>((emitFunction: EmitValue<number>): void => {
      emit = emitFunction;
    });

    const iterator: AsyncIterator<number> = resource.iterator()[Symbol.asyncIterator]();

    const pending: Promise<IteratorResult<number>> = iterator.next();
    emit(13);

    expect((await pending).value).toBe(13);

    await iterator.return?.();
    await resource.close();
  });

  it('iterator() tolerates values dropped while not pulling (edge policy)', async () => {
    let emit!: EmitValue<number>;
    const resource = new ListenerResource<number>((emitFunction: EmitValue<number>): void => {
      emit = emitFunction;
    });

    const iterator: AsyncIterator<number> = resource.iterator()[Symbol.asyncIterator]();

    const first: Promise<IteratorResult<number>> = iterator.next();
    emit(1);
    expect((await first).value).toBe(1);

    emit(2);

    const second: Promise<IteratorResult<number>> = iterator.next();
    emit(3);
    expect((await second).value).toBe(3);

    await iterator.return?.();
    await resource.close();
  });

  it('rethrows the error when init throws', () => {
    const sentinel: Error = new Error('init failed');

    let thrown: unknown;

    try {
      new ListenerResource<number>((): void => {
        throw sentinel;
      });
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toBe(sentinel);
  });

  it('removes multiple listeners within the same cleanup cycle', async () => {
    let emit!: EmitValue<number>;
    const resource = new ListenerResource<number>((emitFunction: EmitValue<number>): void => {
      emit = emitFunction;
    });

    const removed1: number[] = [];
    const removed2: number[] = [];
    const kept: number[] = [];

    const controller1: AbortController = new AbortController();
    const controller2: AbortController = new AbortController();
    resource.listen(
      (value: number): void => {
        removed1.push(value);
      },
      { signal: controller1.signal },
    );
    resource.listen(
      (value: number): void => {
        removed2.push(value);
      },
      { signal: controller2.signal },
    );
    resource.listen((value: number): void => {
      kept.push(value);
    });

    emit(1);
    expect(removed1).toEqual([1]);
    expect(removed2).toEqual([1]);
    expect(kept).toEqual([1]);

    controller1.abort();
    controller2.abort();

    emit(2);
    expect(removed1).toEqual([1]);
    expect(removed2).toEqual([1]);
    expect(kept).toEqual([1, 2]);

    await setImmediateAsync();

    emit(3);
    expect(removed1).toEqual([1]);
    expect(removed2).toEqual([1]);
    expect(kept).toEqual([1, 2, 3]);

    await resource.close();
  });

  it('removes all occurrences of a listener when its signal aborts', async () => {
    let emit!: EmitValue<number>;
    const resource = new ListenerResource<number>((emitFunction: EmitValue<number>): void => {
      emit = emitFunction;
    });

    const received: number[] = [];
    const listener: EmitValue<number> = (value: number): void => {
      received.push(value);
    };

    const controller: AbortController = new AbortController();
    resource.listen(listener, { signal: controller.signal });
    resource.listen(listener, { signal: controller.signal });

    emit(1);
    expect(received).toEqual([1, 1]);

    controller.abort();

    emit(2);
    expect(received).toEqual([1, 1]);

    await setImmediateAsync();

    emit(3);
    expect(received).toEqual([1, 1]);

    await resource.close();
  });

  it('iterator() accepts an explicit signal', async () => {
    let emit!: EmitValue<number>;
    const resource = new ListenerResource<number>((emitFunction: EmitValue<number>): void => {
      emit = emitFunction;
    });

    const controller: AbortController = new AbortController();
    const iterator: AsyncIterator<number> = resource
      .iterator({ signal: controller.signal })
      [Symbol.asyncIterator]();

    const pending: Promise<IteratorResult<number>> = iterator.next();
    emit(5);
    expect((await pending).value).toBe(5);

    controller.abort();
    await expect(iterator.next()).rejects.toThrow();

    await resource.close();
  });

  it('supports for-await iteration over the resource', async () => {
    let emit!: EmitValue<number>;
    const resource = new ListenerResource<number>((emitFunction: EmitValue<number>): void => {
      emit = emitFunction;
    });

    const received: number[] = [];
    const consume = async (): Promise<void> => {
      for await (const value of resource) {
        received.push(value);
      }
    };

    const done: Promise<void> = consume();
    await setImmediateAsync();

    emit(1);
    await setImmediateAsync();
    expect(received).toEqual([1]);

    const expectation: Promise<void> = expect(done).rejects.toBe('because');
    await resource.close('because');
    await expectation;
  });

  it('next() rejects when the resource closes', async () => {
    const resource = new ListenerResource<number>((): void => {});

    const promise: Promise<number> = resource.next();
    const expectation: Promise<void> = expect(promise).rejects.toBe('because');

    await resource.close('because');
    await expectation;
  });

  it('next() rejects when the provided signal aborts', async () => {
    const resource = new ListenerResource<number>((): void => {});

    const reason: Error = new Error('caller aborted');
    const caller: AbortController = new AbortController();
    const promise: Promise<number> = resource.next({ signal: caller.signal });
    const expectation: Promise<void> = expect(promise).rejects.toBe(reason);

    caller.abort(reason);
    await expectation;
  });

  it('next() keeps working after a rejected next()', async () => {
    let emit!: EmitValue<number>;
    const resource = new ListenerResource<number>((emitFunction: EmitValue<number>): void => {
      emit = emitFunction;
    });

    const caller: AbortController = new AbortController();
    const rejected: Promise<number> = resource.next({ signal: caller.signal });
    const expectation: Promise<void> = expect(rejected).rejects.toBeDefined();
    caller.abort();
    await expectation;

    const promise: Promise<number> = resource.next();
    emit(7);
    await expect(promise).resolves.toBe(7);

    await resource.close();
  });
});

describe('runTask contract (pinned for next())', () => {
  it('aborts the task signal when the task completes', async () => {
    const controller: AbortController = new AbortController();
    const closeStack = new CloseStack(controller.signal);

    let taskSignal: AbortSignal | undefined;
    const result: number = await closeStack.runTask((signal: AbortSignal): Promise<number> => {
      taskSignal = signal;
      return Promise.resolve(42);
    });

    expect(result).toBe(42);
    expect(taskSignal?.aborted).toBe(true);
  });
});

interface OnCloseLike {
  (reason: unknown): PromiseLike<void> | void;
}
