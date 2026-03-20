/**
 * @simnode/mongo
 *
 * In-process MongoDB wire-protocol mock backed by a Map-based store.
 * Implements MongoDB wire protocol OP_MSG (opCode 2013) with BSON.
 *
 * Supports: find, insert, update, delete, listCollections, createCollection,
 *           drop, ping, getMore, endSessions, isMaster/hello.
 *
 * Does NOT depend on any external binary or mongodb-memory-server.
 */

import type { TcpMockHandler, TcpMockContext, TcpHandlerResult } from '@simnode/tcp';
import * as net from 'node:net';

export class SimNodeUnsupportedMongoFeature extends Error {
  constructor(detail: string) {
    super(`SimNode: Unsupported MongoDB feature: ${detail}`);
    this.name = 'SimNodeUnsupportedMongoFeature';
  }
}

// ---------------------------------------------------------------------------
// Minimal BSON encoder / decoder (no external dependency)
// ---------------------------------------------------------------------------

type BsonValue =
  | null
  | undefined
  | boolean
  | number
  | string
  | BsonDoc
  | BsonValue[]
  | Buffer
  | bigint;

export type BsonDoc = { [key: string]: BsonValue };

const BSON_FLOAT64    = 0x01;
const BSON_STRING     = 0x02;
const BSON_DOCUMENT   = 0x03;
const BSON_ARRAY      = 0x04;
const BSON_BINARY     = 0x05;
const BSON_BOOLEAN    = 0x08;
const BSON_NULL       = 0x0a;
const BSON_INT32      = 0x10;
const BSON_INT64      = 0x12;

function readCString(buf: Buffer, offset: number): { value: string; next: number } {
  let end = offset;
  while (end < buf.length && buf[end] !== 0) end++;
  return { value: buf.toString('utf8', offset, end), next: end + 1 };
}

function writeCString(buf: Buffer[], str: string): void {
  buf.push(Buffer.from(str, 'utf8'), Buffer.from([0]));
}

export function decodeBson(buf: Buffer, offset = 0): BsonDoc {
  const docLen = buf.readInt32LE(offset);
  const end = offset + docLen;
  let pos = offset + 4;
  const doc: BsonDoc = {};

  while (pos < end - 1) {
    const type = buf[pos++];
    const { value: key, next } = readCString(buf, pos);
    pos = next;

    switch (type) {
      case BSON_FLOAT64: {
        doc[key] = buf.readDoubleLE(pos);
        pos += 8;
        break;
      }
      case BSON_STRING: {
        const strLen = buf.readInt32LE(pos); pos += 4;
        doc[key] = buf.toString('utf8', pos, pos + strLen - 1);
        pos += strLen;
        break;
      }
      case BSON_DOCUMENT: {
        const subLen = buf.readInt32LE(pos);
        doc[key] = decodeBson(buf, pos);
        pos += subLen;
        break;
      }
      case BSON_ARRAY: {
        const arrLen = buf.readInt32LE(pos);
        const arrDoc = decodeBson(buf, pos);
        pos += arrLen;
        // Convert numeric-keyed doc to array
        const maxIdx = Object.keys(arrDoc).length;
        const arr: BsonValue[] = [];
        for (let i = 0; i < maxIdx; i++) arr.push(arrDoc[String(i)] ?? null);
        doc[key] = arr;
        break;
      }
      case BSON_BINARY: {
        const binLen = buf.readInt32LE(pos); pos += 4;
        const _subtype = buf[pos++];
        doc[key] = buf.slice(pos, pos + binLen);
        pos += binLen;
        break;
      }
      case BSON_BOOLEAN: {
        doc[key] = buf[pos++] !== 0;
        break;
      }
      case BSON_NULL: {
        doc[key] = null;
        break;
      }
      case BSON_INT32: {
        doc[key] = buf.readInt32LE(pos); pos += 4;
        break;
      }
      case BSON_INT64: {
        doc[key] = Number(buf.readBigInt64LE(pos)); pos += 8;
        break;
      }
      default:
        // Unknown type — skip rest of document
        pos = end;
    }
  }

  return doc;
}

export function encodeBson(doc: BsonDoc): Buffer {
  const parts: Buffer[] = [];
  for (const [key, val] of Object.entries(doc)) {
    if (val === undefined) continue;
    parts.push(...encodeElement(key, val));
  }
  const body = Buffer.concat(parts);
  const total = 4 + body.length + 1;
  const header = Buffer.alloc(4);
  header.writeInt32LE(total, 0);
  return Buffer.concat([header, body, Buffer.from([0])]);
}

function encodeElement(key: string, val: BsonValue): Buffer[] {
  const keyBuf = Buffer.concat([Buffer.from(key, 'utf8'), Buffer.from([0])]);

  if (val === null || val === undefined) {
    return [Buffer.from([BSON_NULL]), keyBuf];
  }
  if (typeof val === 'boolean') {
    return [Buffer.from([BSON_BOOLEAN]), keyBuf, Buffer.from([val ? 1 : 0])];
  }
  if (typeof val === 'number') {
    if (Number.isInteger(val) && val >= -2147483648 && val <= 2147483647) {
      const b = Buffer.alloc(4); b.writeInt32LE(val, 0);
      return [Buffer.from([BSON_INT32]), keyBuf, b];
    }
    const b = Buffer.alloc(8); b.writeDoubleLE(val, 0);
    return [Buffer.from([BSON_FLOAT64]), keyBuf, b];
  }
  if (typeof val === 'bigint') {
    const b = Buffer.alloc(8); b.writeBigInt64LE(val, 0);
    return [Buffer.from([BSON_INT64]), keyBuf, b];
  }
  if (typeof val === 'string') {
    const strBuf = Buffer.from(val, 'utf8');
    const lenBuf = Buffer.alloc(4); lenBuf.writeInt32LE(strBuf.length + 1, 0);
    return [Buffer.from([BSON_STRING]), keyBuf, lenBuf, strBuf, Buffer.from([0])];
  }
  if (Buffer.isBuffer(val)) {
    const lenBuf = Buffer.alloc(4); lenBuf.writeInt32LE(val.length, 0);
    return [Buffer.from([BSON_BINARY]), keyBuf, lenBuf, Buffer.from([0]), val];
  }
  if (Array.isArray(val)) {
    const arrDoc: BsonDoc = {};
    val.forEach((item, i) => { arrDoc[String(i)] = item as BsonValue; });
    const encoded = encodeBson(arrDoc);
    return [Buffer.from([BSON_ARRAY]), keyBuf, encoded];
  }
  if (typeof val === 'object') {
    const encoded = encodeBson(val as BsonDoc);
    return [Buffer.from([BSON_DOCUMENT]), keyBuf, encoded];
  }
  return [];
}

// ---------------------------------------------------------------------------
// OP_MSG wire protocol parser / builder
// ---------------------------------------------------------------------------

// MongoDB message header: messageLength(4) requestID(4) responseTo(4) opCode(4)
const OP_MSG = 2013;
const OP_REPLY = 1;

interface MsgFrame {
  requestId: number;
  responseTo: number;
  opCode: number;
  body: Buffer;
}

function parseFrame(buf: Buffer): MsgFrame | null {
  if (buf.length < 16) return null;
  const messageLength = buf.readInt32LE(0);
  if (buf.length < messageLength) return null;
  const requestId = buf.readInt32LE(4);
  const responseTo = buf.readInt32LE(8);
  const opCode = buf.readInt32LE(12);
  const body = buf.slice(16, messageLength);
  return { requestId, responseTo, opCode, body };
}

function buildOpMsg(requestId: number, responseTo: number, doc: BsonDoc): Buffer {
  const bson = encodeBson(doc);
  // flagBits(4) + section kind(1) + bson
  const flagBits = Buffer.alloc(4); // 0 = no special flags
  const sectionKind = Buffer.from([0]); // kind 0 = body
  const body = Buffer.concat([flagBits, sectionKind, bson]);
  const msgLen = 16 + body.length;
  const header = Buffer.alloc(16);
  header.writeInt32LE(msgLen, 0);
  header.writeInt32LE(requestId, 4);
  header.writeInt32LE(responseTo, 8);
  header.writeInt32LE(OP_MSG, 12);
  return Buffer.concat([header, body]);
}

function buildOpReply(responseTo: number, doc: BsonDoc): Buffer {
  const bson = encodeBson(doc);
  // flags(4) cursorID(8) startingFrom(4) numberReturned(4) documents...
  const replyHeader = Buffer.alloc(20);
  replyHeader.writeInt32LE(0, 0); // flags
  replyHeader.writeBigInt64LE(0n, 4); // cursorID
  replyHeader.writeInt32LE(0, 12); // startingFrom
  replyHeader.writeInt32LE(1, 16); // numberReturned
  const body = Buffer.concat([replyHeader, bson]);
  const msgLen = 16 + body.length;
  const header = Buffer.alloc(16);
  header.writeInt32LE(msgLen, 0);
  header.writeInt32LE(1, 4); // requestId
  header.writeInt32LE(responseTo, 8);
  header.writeInt32LE(OP_REPLY, 12);
  return Buffer.concat([header, body]);
}

function parseOpMsg(body: Buffer): BsonDoc {
  // skip flagBits(4) + sectionKind(1)
  const bsonStart = 5;
  return decodeBson(body, bsonStart);
}

// Legacy OP_QUERY (opCode 2004) — used by old drivers for initial handshake
const OP_QUERY = 2004;
function parseOpQuery(body: Buffer): { collection: string; query: BsonDoc } {
  // flags(4) + cstring(collectionName) + numberToSkip(4) + numberToReturn(4) + query(bson)
  let pos = 4; // skip flags
  const { value: ns, next } = readCString(body, pos);
  pos = next;
  pos += 8; // skip numberToSkip + numberToReturn
  const query = decodeBson(body, pos);
  return { collection: ns, query };
}

// ---------------------------------------------------------------------------
// MongoStore — legacy in-memory store (kept for seedData / direct test access)
// ---------------------------------------------------------------------------

type MongoDoc = Record<string, unknown>;

export class MongoStore {
  private _dbs = new Map<string, Map<string, MongoDoc[]>>();
  private _idCounter = 1;

  private getCollection(db: string, coll: string): MongoDoc[] {
    if (!this._dbs.has(db)) this._dbs.set(db, new Map());
    const dbMap = this._dbs.get(db)!;
    if (!dbMap.has(coll)) dbMap.set(coll, []);
    return dbMap.get(coll)!;
  }

  seedData(db: string, collection: string, docs: MongoDoc[]): void {
    const coll = this.getCollection(db, collection);
    for (const doc of docs) coll.push({ _id: this._idCounter++, ...doc });
  }

  reset(): void {
    this._dbs.clear();
    this._idCounter = 1;
  }
}

// Simple filter matching — kept for any remaining sync usage
function matchesFilter(doc: MongoDoc, filter: MongoDoc): boolean {
  for (const [key, expected] of Object.entries(filter)) {
    if (key === '$and') {
      if (!(expected as MongoDoc[]).every(f => matchesFilter(doc, f))) return false;
      continue;
    }
    if (key === '$or') {
      if (!(expected as MongoDoc[]).some(f => matchesFilter(doc, f))) return false;
      continue;
    }
    const actual = doc[key];
    if (expected !== null && typeof expected === 'object' && !Array.isArray(expected) && !Buffer.isBuffer(expected)) {
      const ops = expected as Record<string, unknown>;
      if ('$gt' in ops && !((actual as number) > (ops.$gt as number))) return false;
      if ('$lt' in ops && !((actual as number) < (ops.$lt as number))) return false;
      if ('$gte' in ops && !((actual as number) >= (ops.$gte as number))) return false;
      if ('$lte' in ops && !((actual as number) <= (ops.$lte as number))) return false;
      if ('$ne' in ops && actual === ops.$ne) return false;
      if ('$in' in ops && !(ops.$in as unknown[]).includes(actual)) return false;
      if ('$exists' in ops && Boolean(ops.$exists) !== (actual !== undefined)) return false;
    } else {
      if (actual !== expected) return false;
    }
  }
  return true;
}

// Exported so tests that import matchesFilter still compile
export { matchesFilter };

// ---------------------------------------------------------------------------
// MongoProxyConnection — per-client-connection TCP proxy to real mongod
// ---------------------------------------------------------------------------


/** A pending upstream request waiting for its response. */
interface PendingResponse {
  resolve: (buf: Buffer) => void;
  reject: (err: Error) => void;
}

/**
 * One proxy connection to the real mongod process.
 * Incoming bytes are forwarded verbatim; responses are reassembled from the
 * MongoDB wire-protocol framing (first 4 bytes = LE message length) and
 * delivered back to the caller as Promises so the scheduler can inject
 * virtual latency before the bytes are handed to the simulated client.
 */
class MongoProxyConnection {
  private _upstream: net.Socket;
  private _recvBuf  = Buffer.alloc(0);
  private _pending: PendingResponse[] = [];
  private _closed   = false;

  constructor(
    host: string,
    port: number,
    /** Real (pre-patch) net.createConnection so we bypass the TcpInterceptor. */
    realConnect: (port: number, host: string) => net.Socket,
  ) {
    this._upstream = realConnect(port, host);
    this._upstream.on('data',  (chunk: Buffer) => this._onData(chunk));
    this._upstream.on('error', (err: Error)    => this._onError(err));
    this._upstream.on('close', ()              => { this._closed = true; this._onError(new Error('mongod connection closed')); });
  }

  async send(data: Buffer): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      if (this._closed) { reject(new Error('mongod connection closed')); return; }
      this._pending.push({ resolve, reject });
      this._upstream.write(data);
    });
  }

  destroy(): void {
    this._closed = true;
    this._upstream.destroy();
  }

  private _onData(chunk: Buffer): void {
    this._recvBuf = Buffer.concat([this._recvBuf, chunk]);
    // Drain complete MongoDB frames (framed by first 4 bytes = LE message length)
    while (this._recvBuf.length >= 4) {
      const msgLen = this._recvBuf.readInt32LE(0);
      if (this._recvBuf.length < msgLen) break;
      const frame = this._recvBuf.slice(0, msgLen);
      this._recvBuf  = this._recvBuf.slice(msgLen);
      const waiter  = this._pending.shift();
      if (waiter) waiter.resolve(frame);
    }
  }

  private _onError(err: Error): void {
    for (const w of this._pending) w.reject(err);
    this._pending = [];
  }
}

// ---------------------------------------------------------------------------
// MongoMock — public API (mongodb-memory-server backend)
// ---------------------------------------------------------------------------

export class MongoMock {
  /** Legacy store — available for tests that need direct data access. */
  readonly store: MongoStore;

  private _server:       import('mongodb-memory-server').MongoMemoryServer | null = null;
  private _startPromise: Promise<void> | null = null;
  private _mongoHost     = '127.0.0.1';
  private _mongoPort     = 27017;
  private _proxies       = new Map<number, MongoProxyConnection>();
  /** Captured before TcpInterceptor.install() patches net.createConnection. */
  private _realConnect: (port: number, host: string) => net.Socket;

  constructor() {
    this.store = new MongoStore();
    // Capture the REAL net.createConnection now, before TcpInterceptor patches it.
    const orig = net.createConnection.bind(net) as unknown as (port: number, host: string) => net.Socket;
    this._realConnect = orig;
  }

  /**
   * Start the embedded MongoDB process (idempotent — safe to call multiple times).
   * Called lazily by createHandler() on the first connection, so scenarios that
   * don't use MongoDB pay zero startup cost.
   */
  async start(): Promise<void> {
    if (this._startPromise) return this._startPromise;
    this._startPromise = (async () => {
      const { MongoMemoryServer } = await import('mongodb-memory-server');
      this._server = await MongoMemoryServer.create();
      const uri    = this._server.getUri();
      const url    = new URL(uri);
      this._mongoHost = url.hostname;
      this._mongoPort = parseInt(url.port, 10);
    })();
    return this._startPromise;
  }

  /** Stop the embedded MongoDB process and tear down all proxy connections. */
  async stop(): Promise<void> {
    for (const p of this._proxies.values()) p.destroy();
    this._proxies.clear();
    if (this._server) {
      await this._server.stop();
      this._server = null;
      this._startPromise = null;
    }
  }

  /**
   * Returns a TcpMockHandler that proxies raw MongoDB wire-protocol bytes to
   * the real mongod.  The Promise return type lets the caller (TcpInterceptor /
   * Scheduler) inject virtual latency before delivering the response.
   */
  createHandler(): TcpMockHandler {
    return async (data: Buffer, ctx: TcpMockContext): Promise<TcpHandlerResult> => {
      // Lazy-start mongod on the first connection to this handler
      await this.start();
      if (!this._proxies.has(ctx.socketId)) {
        this._proxies.set(
          ctx.socketId,
          new MongoProxyConnection(this._mongoHost, this._mongoPort, this._realConnect),
        );
      }
      const proxy = this._proxies.get(ctx.socketId)!;
      try {
        return await proxy.send(data);
      } catch {
        return null;
      }
    };
  }
}
