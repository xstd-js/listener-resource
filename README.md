[![npm (scoped)](https://img.shields.io/npm/v/@xstd/listener-resource.svg)](https://www.npmjs.com/package/@xstd/listener-resource)
![npm](https://img.shields.io/npm/dm/@xstd/listener-resource.svg)
![NPM](https://img.shields.io/npm/l/@xstd/listener-resource.svg)
![npm type definitions](https://img.shields.io/npm/types/@xstd/listener-resource.svg)
![coverage](https://img.shields.io/badge/coverage-100%25-green)
![AI generation](https://img.shields.io/badge/AI_generation-low-yellow)

<picture>
  <source height="64" media="(prefers-color-scheme: dark)" srcset="https://github.com/xstd-js/website/blob/main/assets/logo/png/logo-large-dark.png?raw=true">
  <source height="64" media="(prefers-color-scheme: light)" srcset="https://github.com/xstd-js/website/blob/main/assets/logo/png/logo-large-light.png?raw=true">
  <img height="64" alt="Shows a black logo in light color mode and a white one in dark color mode." src="https://github.com/xstd-js/website/blob/main/assets/logo/png/logo-large-light.png?raw=true">
</picture>

## @xstd/listener-resource

A resource for event listener/emitter

## 📦 Installation

```shell
yarn add @xstd/listener-resource
# or
npm install @xstd/listener-resource --save
```

## 📜 Documentation

A `ListenerResource` is a broadcast hub: values emitted by the source are delivered synchronously, in registration order, to all the registered listeners.

It extends the `Resource` class from [`@xstd/resource`](https://www.npmjs.com/package/@xstd/resource), so it integrates with the resource lifecycle: closing the resource unregisters all the listeners and rejects any pending consumption.

### 🏗️ Creating a `ListenerResource`

The constructor takes an `init` function, called once, synchronously, with an `emit` function. Use `emit` to broadcast a value to all the registered listeners. The `init` function may return a teardown function, invoked with the close reason when the resource closes.

```ts
import { ListenerResource } from '@xstd/listener-resource';

const resource = new ListenerResource<number>((emit) => {
  const interval: ReturnType<typeof setInterval> = setInterval((): void => emit(Date.now()), 1000);
  return (): void => clearInterval(interval); // teardown, invoked with the close reason on close
});
```

Calling `emit` after the resource is closed throws.

### 👂 `listen`

Registers a listener invoked each time a value is emitted.

- Mirrors `EventTarget.addEventListener` semantics: the listener is unregistered when the provided `signal` aborts.
- Registering the same listener multiple times registers it multiple times.
- Registering a listener with an already aborted `signal` does nothing.
- The dispatch is fail-fast: when a listener throws, the remaining listeners are not invoked and the error is rethrown to the emitter.

```ts
const controller: AbortController = new AbortController();

resource.listen((value: number): void => console.log(value), { signal: controller.signal });

controller.abort(); // the listener is unregistered
```

Throws if the resource is closed.

### ⏭️ `next`

Resolves with the next emitted value.

The returned promise is tied to this resource's lifecycle: it rejects as soon as the provided `signal` aborts or the resource closes, with the corresponding reason.

```ts
const value: number = await resource.next();
```

### 🔁 `iterator` & `for await...of`

Iterates over the emitted values. `ListenerResource` also implements `Symbol.asyncIterator`, enabling `for await...of` directly over the resource.

Values are buffered according to the `queueingPolicy` option: with the default `EdgeQueuingPolicy`, values emitted while the consumer is busy processing the previous one are dropped. The internal listener is unregistered when the iteration ends early (e.g. `break`), when the provided `signal` aborts, or when the resource closes.

```ts
for await (const value of resource) {
  if (value > LIMIT) break; // the internal listener is unregistered automatically
}

await resource.close();
```

### 📚 Full example

```ts
import { ListenerResource } from '@xstd/listener-resource';

const resource = new ListenerResource<number>((emit) => {
  const interval: ReturnType<typeof setInterval> = setInterval((): void => emit(Date.now()), 1000);
  return (): void => clearInterval(interval); // teardown, invoked with the close reason on close
});

const controller: AbortController = new AbortController();
resource.listen((value: number): void => console.log(value), { signal: controller.signal });

for await (const value of resource) {
  if (value > LIMIT) break; // the internal listener is unregistered automatically
}

await resource.close();
```
