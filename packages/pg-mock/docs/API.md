# @crashlab/pg-mock — API Reference

## Responsibility

An in-process PostgreSQL mock backed by **PGlite** (a WASM-compiled PostgreSQL). Speaks the full PostgreSQL wire protocol (simple query + extended query with Parse/Bind/Execute/Sync) so the `pg` driver works without modification. No external Postgres binary needed — the entire database runs in-memory inside the worker thread.

---

## Classes

### `PgMock`

#### Constructor

```ts
new PgMock()
```

Creates a new PGlite instance. Initialisation is lazy and asynchronous — call `ready()` before making wire-protocol queries if you have pending `seedData()` calls.

---

### Seeding

#### `pg.seedData(table, rows): void`

Pre-populate a table before the scenario runs. Creates the table if it doesn't exist (all columns are `TEXT`).

```ts
env.pg.seedData('products', [
  { id: '1', name: 'Widget', stock: '100' },
  { id: '2', name: 'Gadget', stock: '0'  },
]);
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `table` | `string` | Table name |
| `rows` | `Array<Record<string, string \| null>>` | Row data — all values must be strings or `null` |

---

### Lifecycle

#### `pg.ready(): Promise<void>`

Resolves once PGlite is fully initialised **and** all pending `seedData()` calls have been applied. Await this in `createEnv()` before interceptors are installed — PGlite's WASM init uses real timers which must complete before virtual timers are patched.

```ts
await pg.ready();
```

---

### Direct Query Access

#### `pg.query<T>(sql): Promise<{ rows: T[]; fields: Array<{ name: string }> }>`

Execute raw SQL directly against the embedded PGlite instance. Useful for assertions in scenario code.

```ts
const { rows } = await env.pg.query('SELECT * FROM orders WHERE status = $1');
```

---

### TCP Integration

#### `pg.createHandler(): TcpMockHandler`

Returns a `TcpMockHandler` for use with `TcpInterceptor.mock()`. Each unique `socketId` in `TcpMockContext` gets its own `PgConnection` state machine, supporting multiple concurrent connections.

```ts
tcp.mock('localhost:5432', { handler: pg.createHandler() });
```

Called automatically by `createEnv()`.

---

## Protocol Support

| Message Type | Wire Byte | Supported |
|-------------|-----------|-----------|
| SSL probe | — | ✓ (declined with `N`) |
| Startup | — | ✓ |
| Simple Query | `Q` | ✓ |
| Parse | `P` | ✓ |
| Bind | `B` | ✓ (text + binary format codes, `NULL` params) |
| Describe | `D` | ✓ (returns `NoData`) |
| Execute | `E` | ✓ |
| Sync | `S` | ✓ |
| Terminate | `X` | ✓ |
| Transaction (BEGIN/COMMIT/ROLLBACK) | — | ✓ |

---

## Types

```ts
class CrashLabUnsupportedPGFeature extends Error {}
```

Thrown when an unsupported wire-protocol feature is encountered.
