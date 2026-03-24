# @crashlab/http-proxy — API Reference

## Responsibility

Intercepts Node.js `http.request` / `https.request` (and the global `fetch`) inside a simulation worker, routing matched URLs to in-memory mock responses instead of real network calls. Supports latency injection, network partitions, dynamic response handlers, and call recording for assertions.

---

## Classes

### `HttpInterceptor`

#### Constructor

```ts
new HttpInterceptor(opts?: { clock?: IClock; scheduler?: IScheduler })
```

Providing a `clock` + `scheduler` enables virtual-latency responses and PRNG-ordered same-tick completions. Both are wired automatically when constructed via `createEnv()`.

---

### Mock Registration

#### `interceptor.mock(urlPattern, config): this`

Register a mock response for a URL pattern.

```ts
http.mock('https://api.stripe.com/v1/charges', {
  status: 200,
  body: { id: 'ch_123', status: 'succeeded' },
  latency: 50,  // virtual ms delay before response arrives
});

// Prefix match — any URL starting with this prefix
http.mock('https://api.stripe.com/', {
  status: 200,
  body: { ok: true },
  match: 'prefix',
});

// Regex match
http.mock('/api/users/\\d+', {
  status: 200,
  body: { name: 'Alice' },
  match: 'regex',
});
```

**`MockResponseConfig`:**

| Field | Type | Description |
|-------|------|-------------|
| `status` | `number` | HTTP status code (default: `200`) |
| `headers` | `Record<string,string>` | Response headers (default: `content-type: application/json`) |
| `body` | `unknown` | Response body — objects are JSON-serialised |
| `latency` | `number` | Virtual-clock delay in ms before the response is delivered |
| `handler` | `(call) => {status, body?, headers?}` | Dynamic handler — overrides static `body`/`status` per call |
| `match` | `'exact' \| 'prefix' \| 'regex'` | URL matching mode (default: `'exact'`) |

---

#### `interceptor.fail(urlPattern, config): this`

Register a mock that returns a network error instead of a response.

```ts
// Error immediately
http.fail('https://payments.example.com/charge', { error: 'ECONNREFUSED' });

// Succeed the first 2 calls, then start failing
http.fail('https://payments.example.com/charge', { after: 2, error: 'ETIMEDOUT' });
```

**`FailConfig`:**

| Field | Type | Description |
|-------|------|-------------|
| `error` | `string` | Error message emitted on the request socket |
| `after` | `number` | Number of successful calls before the error starts firing |

---

### Fault Injection

#### `interceptor.blockAll(duration: number): void`

Block **all** non-localhost HTTP requests for `duration` virtual ms. Blocked requests receive `ECONNREFUSED`. Local requests (supertest, in-process test servers) are never blocked.

```ts
faults.networkPartition(500); // internally calls http.blockAll(500)
```

#### `interceptor.setDefaultLatency(ms: number): void`

Add a global extra latency to every response. Used by `FaultInjector.slowDatabase()`.

---

### Observation

#### `interceptor.calls(method?, urlPrefix?): RecordedCall[]`

Return all recorded calls, optionally filtered by HTTP method and/or URL prefix.

```ts
const charges = http.calls('POST', 'https://api.stripe.com/v1/charges');
expect(charges).toHaveLength(2);
expect(charges[0].body).toContain('"amount":1000');
```

**`RecordedCall`:**

```ts
interface RecordedCall {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
  timestamp: number; // virtual clock time when request was intercepted
}
```

---

### Lifecycle

| Method | Description |
|--------|-------------|
| `install()` | Patch `http.request`, `https.request`, and their `.get` variants |
| `uninstall()` | Restore the original request functions |
| `reset()` | Clear all registered routes and recorded calls |

---

## Functions

### `install(http, opts?): HttpProxyInstallResult`

High-level install helper used by `createEnv()`. Patches both `http`/`https` modules and returns `{ uninstall }`.

### `createFetchPatch(http, origFetch): typeof fetch`

Returns a patched `fetch` that routes through the `HttpInterceptor`. Applied to `globalThis.fetch` by the simulation worker.

---

## Types

```ts
interface IClock {
  now(): number;
  setTimeout(cb: (...args: unknown[]) => void, delay: number): number;
}

interface IScheduler {
  enqueueCompletion(op: { id: string; when: number; run: () => Promise<void> | void }): void;
}
```
