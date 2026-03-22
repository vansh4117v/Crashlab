# @simnode/redis-mock — API Reference

## Responsibility

A pure in-memory Redis mock backed by **ioredis-mock**. Speaks the RESP (REdis Serialization Protocol) wire format so `ioredis` and `redis` drivers work without modification. Parses incoming RESP command frames, executes them against an in-memory store, and encodes responses back to RESP — all within the worker thread. No external Redis binary needed.

---

## Classes

### `RedisMock`

#### Constructor

```ts
new RedisMock(opts?: RedisMockOpts)
```

**`RedisMockOpts`:**

| Field | Default | Description |
|-------|---------|-------------|
| `data` | `{}` | Initial key-value data to pre-populate |

---

### Seeding

#### `redis.seedData(key, value): void`

Pre-populate a key before the scenario's first Redis command is processed. All seeds are applied atomically on the first handler invocation.

```ts
env.redis.seedData('session:user:42', JSON.stringify({ role: 'admin' }));
env.redis.seedData('rate-limit:127.0.0.1', '5');
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `key` | `string` | Redis key |
| `value` | `string` | String value (serialise objects yourself) |

---

### Teardown

#### `redis.flush(): Promise<void>`

Execute `FLUSHDB` against the in-memory store and reset the seeded flag. Called automatically by the simulation worker's `finally` block for clean per-seed isolation.

---

### TCP Integration

#### `redis.createHandler(): TcpMockHandler`

Returns a `TcpMockHandler` for use with `TcpInterceptor.mock()`. Parses all RESP commands from the incoming buffer (handles pipelining — multiple commands in a single TCP frame), executes them, and returns a combined RESP response.

```ts
tcp.mock('localhost:6379', { handler: redis.createHandler() });
```

Called automatically by `createEnv()`.

---

## RESP Protocol Notes

- **Pipelining:** Multiple RESP commands in one TCP packet are all executed and their responses concatenated into a single reply.
- **Inline commands:** Plain-text commands (not `*N\r\n` arrays) are also parsed and supported.
- **NULL bulk strings:** `$-1\r\n` is correctly decoded as `NULL` and passed to ioredis-mock as `'NULL'`.
- **Simple strings:** Commands like `SET`, `FLUSHDB`, `AUTH` return `+OK\r\n` (not bulk string).

---

## Types

```ts
interface RedisMockOpts {
  data?: Record<string, unknown>;
}
```
