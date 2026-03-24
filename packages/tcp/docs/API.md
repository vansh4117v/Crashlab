# @crashlab/tcp — API Reference

## Responsibility

Intercepts all outbound TCP connections inside a simulation worker by patching `net.Socket.prototype.connect` and `net.createConnection`. Each connection is routed to an in-memory `TcpMockHandler` based on the target `host:port`. Handlers (PgMock, RedisMock, MongoMock) receive raw wire-protocol bytes and return response bytes — no real network I/O occurs. Also supports binding loopback TCP servers for out-of-process binaries (e.g. Prisma engine).

---

## Classes

### `TcpInterceptor`

#### Constructor

```ts
new TcpInterceptor(opts?: { clock?: IClock; scheduler?: IScheduler })
```

Providing `clock` + `scheduler` enables virtual-latency responses and PRNG-ordered I/O completions.

---

### Mock Registration

#### `interceptor.mock(target, config)`

Register an in-memory handler for a specific `host:port`.

```ts
tcp.mock('localhost:5432', { handler: pg.createHandler() });
tcp.mock('localhost:6379', { handler: redis.createHandler() });
tcp.mock('localhost:27017', { handler: mongo.createHandler() });
```

`target` format: `"host:port"` string.

**Config:**

| Field | Type | Description |
|-------|------|-------------|
| `handler` | `TcpMockHandler` | Async function that processes incoming bytes and returns response bytes |
| `latency` | `number` | Default virtual-clock latency (ms) for all responses from this mock |

---

#### `interceptor.addLocalServer(port, handler, latency?, onError?)`

Bind a real loopback TCP server on the given port. Used for out-of-process binaries (Prisma engine, etc.) that can't be intercepted client-side. Errors (e.g. `EADDRINUSE`) are non-fatal — in-process drivers continue using the client-side interceptor.

```ts
tcp.addLocalServer(5432, pg.createHandler(), 0, (err) => {
  console.warn(`Port 5432 in use: ${err.message}`);
});
```

---

### Fault Injection

#### `interceptor.blockAll(duration: number): void`

Drop all new TCP connections for `duration` virtual ms. Connections receive `ECONNREFUSED`.

#### `interceptor.setDefaultLatency(ms: number): void`

Apply extra latency to all mock responses globally.

---

### Lifecycle

| Method | Description |
|--------|-------------|
| `install()` | Patch `net.Socket.prototype.connect` and `net.createConnection` |
| `uninstall()` | Restore original socket methods |
| `stopLocalServers(): Promise<void>` | Close all loopback TCP servers bound via `addLocalServer()` |

---

## Classes

### `VirtualSocket`

The internal duplex stream that replaces a real socket. It feeds incoming data to the registered `TcpMockHandler`, enqueues the response via the `Scheduler`, then delivers the bytes back to the caller at the scheduled virtual time.

Not intended for direct use — created automatically by `TcpInterceptor` when a mock connection is established.

---

## Error Classes

### `CrashLabUnmockedTCPConnectionError`

Thrown when an app attempts a TCP connection to a `host:port` that has no registered mock and is not a local address.

```ts
import { CrashLabUnmockedTCPConnectionError } from '@crashlab/tcp';
```

### `CrashLabUnsupportedProtocolError`

Thrown when a connection lands on a mock but the handler cannot parse the protocol (e.g. TLS inside a plain mock).

---

## Types

```ts
type TcpMockHandler = (
  data: Buffer,
  ctx: TcpMockContext,
) => Promise<TcpHandlerResult>;

type TcpHandlerResult = Buffer | null;

interface TcpMockContext {
  socketId: number;  // unique per-connection ID — use to track connection state
  host: string;
  port: number;
}

interface TcpMockConfig {
  handler: TcpMockHandler;
  latency?: number;
}

interface IClock {
  now(): number;
  setTimeout(cb: (...args: unknown[]) => void, delay: number): number;
}

interface IScheduler {
  enqueueCompletion(op: { id: string; when: number; run: () => Promise<void> | void }): void;
}
```
