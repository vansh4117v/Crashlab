# @crashlab/mongo — API Reference

## Responsibility

Proxies MongoDB wire-protocol bytes from in-process app code to a shared `mongodb-memory-server` instance started once per simulation run. Each scenario gets an isolated database (`sim_db_<seed>`), which is automatically dropped at teardown. No custom BSON encoding — bytes are forwarded verbatim, so all MongoDB features work as-is.

---

## Classes

### `MongoMock`

#### Constructor

```ts
new MongoMock(opts?: MongoMockOpts)
```

**`MongoMockOpts`:**

| Field | Default | Description |
|-------|---------|-------------|
| `mongoHost` | `'127.0.0.1'` | Hostname of the shared `MongoMemoryServer` |
| `mongoPort` | `27017` | Port of the shared `MongoMemoryServer` |
| `mongoDbName` | `'test'` | Per-scenario database name (e.g. `sim_db_42`) |

In normal use, all three are provided automatically by the simulation worker via `createEnv()`.

---

### Assertion API

#### `mongo.find(collection, filter?): Promise<Record<string, unknown>[]>`

Query the scenario's isolated database directly via the MongoDB driver. Returns plain objects decoded by the driver (EJSON).

```ts
const docs = await env.mongo.find('orders', { status: 'pending' });
expect(docs).toHaveLength(1);
expect(docs[0].amount).toBe(100);
```

| Parameter | Default | Description |
|-----------|---------|-------------|
| `collection` | — | Collection name |
| `filter` | `{}` | MongoDB query filter |

---

### Teardown

#### `mongo.drop(): Promise<void>`

Drop the scenario's entire database and close the driver connection. Called automatically by the simulation worker's `finally` block for clean per-seed isolation.

---

### TCP Integration

#### `mongo.createHandler(): TcpMockHandler`

Returns a `TcpMockHandler` for use with `TcpInterceptor.mock()`. The handler maintains one proxy connection per socket ID and forwards raw wire-protocol bytes to the real mongod process.

```ts
tcp.mock('localhost:27017', { handler: mongo.createHandler() });
```

This is called automatically by `createEnv()` — you don't need to call it directly in scenarios.

---

## How Isolation Works

Each seed gets a unique database name (`sim_db_<seed>`). The worker patches every `MONGODB_URI`-style environment variable to replace the database name segment with this per-seed name. At the end of the scenario, `mongo.drop()` clears the database, ensuring no state leaks between seeds.

```
mongodb://127.0.0.1:27017/sim_db_42
                              ^^^^^^^
                              unique per seed
```

---

## Types

```ts
interface MongoMockOpts {
  mongoHost?: string;
  mongoPort?: number;
  mongoDbName?: string;
}
```
