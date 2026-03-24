import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { MongoMock } from '../src/index.js';
import { TcpInterceptor } from '@crashlab/tcp';
import { Scheduler } from '@crashlab/scheduler';

const _require = createRequire(import.meta.url);

// ── Shared MongoMemoryServer — started once for the whole file ──────────────

let mongoHost: string;
let mongoPort: number;
let stopServer: () => Promise<void>;

beforeAll(async () => {
  const { MongoMemoryServer } = _require('mongodb-memory-server') as typeof import('mongodb-memory-server');
  const server = await MongoMemoryServer.create();
  const uri = server.getUri();
  const url = new URL(uri);
  mongoHost = url.hostname;
  mongoPort = parseInt(url.port, 10);
  stopServer = () => server.stop().then(() => {});
}, 60_000);

afterAll(async () => {
  await stopServer?.();
});

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Seed data directly into mongod, bypassing MongoMock's proxy layer. */
async function seedCollection(
  dbName: string,
  collection: string,
  docs: Record<string, unknown>[],
): Promise<void> {
  const { MongoClient } = await import('mongodb');
  const client = await MongoClient.connect(`mongodb://${mongoHost}:${mongoPort}`);
  try {
    await client.db(dbName).collection(collection).insertMany(docs);
  } finally {
    await client.close();
  }
}

// ── find() ───────────────────────────────────────────────────────────────────

describe('MongoMock find()', () => {
  it('returns empty array for an empty collection', async () => {
    const mock = new MongoMock({ mongoHost, mongoPort, mongoDbName: 'sim_empty' });
    const docs = await mock.find('users');
    expect(docs).toEqual([]);
    await mock.drop();
  }, 30_000);

  it('returns all documents when no filter is provided', async () => {
    await seedCollection('sim_find_all', 'products', [
      { name: 'Widget', price: 10 },
      { name: 'Gadget', price: 20 },
    ]);
    const mock = new MongoMock({ mongoHost, mongoPort, mongoDbName: 'sim_find_all' });
    const docs = await mock.find('products');
    expect(docs).toHaveLength(2);
    const names = docs.map(d => d['name']);
    expect(names).toContain('Widget');
    expect(names).toContain('Gadget');
    await mock.drop();
  }, 30_000);

  it('filters documents by a field', async () => {
    await seedCollection('sim_find_filter', 'orders', [
      { status: 'pending',  amount: 100 },
      { status: 'complete', amount: 200 },
      { status: 'pending',  amount: 50  },
    ]);
    const mock = new MongoMock({ mongoHost, mongoPort, mongoDbName: 'sim_find_filter' });
    const pending = await mock.find('orders', { status: 'pending' });
    expect(pending).toHaveLength(2);
    expect(pending.every(d => d['status'] === 'pending')).toBe(true);
    await mock.drop();
  }, 30_000);

  it('returns documents from the correct database only', async () => {
    await seedCollection('sim_isolation_a', 'items', [{ tag: 'db-a' }]);
    await seedCollection('sim_isolation_b', 'items', [{ tag: 'db-b' }, { tag: 'db-b' }]);

    const mockA = new MongoMock({ mongoHost, mongoPort, mongoDbName: 'sim_isolation_a' });
    const mockB = new MongoMock({ mongoHost, mongoPort, mongoDbName: 'sim_isolation_b' });

    const docsA = await mockA.find('items');
    const docsB = await mockB.find('items');

    expect(docsA).toHaveLength(1);
    expect(docsB).toHaveLength(2);
    expect(docsA[0]['tag']).toBe('db-a');

    await Promise.all([mockA.drop(), mockB.drop()]);
  }, 30_000);
});

// ── drop() ───────────────────────────────────────────────────────────────────

describe('MongoMock drop()', () => {
  it('removes all documents from the database', async () => {
    await seedCollection('sim_drop', 'items', [{ x: 1 }, { x: 2 }]);
    const mock = new MongoMock({ mongoHost, mongoPort, mongoDbName: 'sim_drop' });
    await mock.drop();

    // A fresh mock on the same db should see an empty collection
    const mock2 = new MongoMock({ mongoHost, mongoPort, mongoDbName: 'sim_drop' });
    const docs = await mock2.find('items');
    expect(docs).toHaveLength(0);
    await mock2.drop();
  }, 30_000);

  it('is a no-op when called before any driver interaction', async () => {
    const mock = new MongoMock({ mongoHost, mongoPort, mongoDbName: 'sim_drop_noop' });
    await expect(mock.drop()).resolves.toBeUndefined();
  }, 30_000);

  it('can be called multiple times without error', async () => {
    await seedCollection('sim_drop_twice', 'items', [{ x: 1 }]);
    const mock = new MongoMock({ mongoHost, mongoPort, mongoDbName: 'sim_drop_twice' });
    await mock.drop();
    await expect(mock.drop()).resolves.toBeUndefined();
  }, 30_000);
});

// ── createHandler() — TCP proxy ──────────────────────────────────────────────

describe('MongoMock createHandler()', () => {
  it('proxies MongoDB driver reads and writes through the TCP handler', async () => {
    const dbName = 'sim_proxy';
    const mock = new MongoMock({ mongoHost, mongoPort, mongoDbName: dbName });
    const tcp = new TcpInterceptor({ scheduler: new Scheduler({ prngSeed: 1 }) });

    tcp.mock(`${mongoHost}:${mongoPort}`, { handler: mock.createHandler() });
    tcp.install();

    try {
      const { MongoClient } = await import('mongodb');
      const client = await MongoClient.connect(`mongodb://${mongoHost}:${mongoPort}/${dbName}`);
      try {
        await client.db(dbName).collection('users').insertOne({ name: 'Alice', role: 'admin' });
        await client.db(dbName).collection('users').insertOne({ name: 'Bob',   role: 'user'  });

        const docs = await client.db(dbName).collection('users').find({}).toArray();
        expect(docs).toHaveLength(2);
        expect(docs.map(d => d['name'])).toContain('Alice');
      } finally {
        await client.close();
      }
    } finally {
      tcp.uninstall();
      await tcp.stopLocalServers();
      await mock.drop();
    }
  }, 30_000);

  it('supports multiple concurrent connections (distinct socketIds)', async () => {
    const dbName = 'sim_proxy_multi';
    const mock = new MongoMock({ mongoHost, mongoPort, mongoDbName: dbName });
    const tcp = new TcpInterceptor({ scheduler: new Scheduler({ prngSeed: 1 }) });

    tcp.mock(`${mongoHost}:${mongoPort}`, { handler: mock.createHandler() });
    tcp.install();

    try {
      const { MongoClient } = await import('mongodb');
      // Two concurrent clients — each gets its own proxy connection (socketId)
      const [c1, c2] = await Promise.all([
        MongoClient.connect(`mongodb://${mongoHost}:${mongoPort}/${dbName}`),
        MongoClient.connect(`mongodb://${mongoHost}:${mongoPort}/${dbName}`),
      ]);
      try {
        await c1.db(dbName).collection('col').insertOne({ src: 'c1' });
        await c2.db(dbName).collection('col').insertOne({ src: 'c2' });

        const all = await mock.find('col');
        expect(all).toHaveLength(2);
        expect(all.map(d => d['src'])).toContain('c1');
        expect(all.map(d => d['src'])).toContain('c2');
      } finally {
        await Promise.all([c1.close(), c2.close()]);
      }
    } finally {
      tcp.uninstall();
      await tcp.stopLocalServers();
      await mock.drop();
    }
  }, 30_000);
});
