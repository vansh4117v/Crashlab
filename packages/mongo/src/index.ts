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
        doc[key] = buf.readDoubleLe ? (buf as any).readDoubleLe(pos) : buf.readDoubleLE(pos);
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
// MongoStore — in-memory collection store
// ---------------------------------------------------------------------------

type MongoDoc = Record<string, unknown>;

export class MongoStore {
  // dbName → collectionName → docs
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
    for (const doc of docs) {
      coll.push({ _id: this._idCounter++, ...doc });
    }
  }

  execCommand(dbName: string, cmd: BsonDoc): BsonDoc {
    const cmdName = Object.keys(cmd).find(k =>
      ['find','insert','update','delete','drop','listCollections',
       'createCollection','ping','isMaster','hello','getMore',
       'endSessions','ismaster'].includes(k)
    );

    if (!cmdName) {
      throw new SimNodeUnsupportedMongoFeature(`Command: ${Object.keys(cmd)[0] ?? 'unknown'}`);
    }

    switch (cmdName) {
      case 'ping':
      case 'isMaster':
      case 'ismaster':
      case 'hello':
        return {
          ok: 1,
          isWritablePrimary: true,
          ismaster: true,
          maxBsonObjectSize: 16777216,
          maxMessageSizeBytes: 48000000,
          maxWriteBatchSize: 100000,
          minWireVersion: 0,
          maxWireVersion: 17,
          readOnly: false,
          connectionId: 1,
        };

      case 'endSessions':
        return { ok: 1 };

      case 'listCollections': {
        const dbMap = this._dbs.get(dbName) ?? new Map();
        const collNames: BsonDoc[] = [];
        for (const name of dbMap.keys()) {
          collNames.push({ name, type: 'collection', options: {}, idIndex: { v: 2, key: { _id: 1 }, name: '_id_' } });
        }
        return {
          cursor: { id: 0, ns: `${dbName}.$cmd.listCollections`, firstBatch: collNames as unknown as BsonValue },
          ok: 1,
        };
      }

      case 'createCollection': {
        const collName = cmd[cmdName] as string;
        this.getCollection(dbName, collName);
        return { ok: 1 };
      }

      case 'drop': {
        const collName = cmd[cmdName] as string;
        const dbMap = this._dbs.get(dbName);
        if (dbMap) dbMap.delete(collName);
        return { ok: 1 };
      }

      case 'find': {
        const collName = cmd.find as string;
        const filter = (cmd.filter ?? {}) as MongoDoc;
        const limit = (cmd.limit as number) ?? 0;
        const skip = (cmd.skip as number) ?? 0;
        const coll = this.getCollection(dbName, collName);
        let results = coll.filter(doc => matchesFilter(doc, filter));
        if (skip > 0) results = results.slice(skip);
        if (limit > 0) results = results.slice(0, limit);
        return {
          cursor: { id: 0, ns: `${dbName}.${collName}`, firstBatch: results as unknown as BsonValue },
          ok: 1,
        };
      }

      case 'insert': {
        const collName = cmd.insert as string;
        const docs = (cmd.documents ?? []) as MongoDoc[];
        const coll = this.getCollection(dbName, collName);
        let n = 0;
        for (const doc of docs) {
          const inserted = { _id: doc._id ?? this._idCounter++, ...doc };
          coll.push(inserted);
          n++;
        }
        return { n, ok: 1 };
      }

      case 'update': {
        const collName = cmd.update as string;
        const updates = (cmd.updates ?? []) as Array<{ q: MongoDoc; u: MongoDoc; upsert?: boolean; multi?: boolean }>;
        const coll = this.getCollection(dbName, collName);
        let nModified = 0;
        let nUpserted = 0;
        for (const upd of updates) {
          const filter = upd.q ?? {};
          const setDoc = ((upd.u as any)?.$set ?? upd.u) as MongoDoc;
          const unsetDoc = ((upd.u as any)?.$unset) as MongoDoc | undefined;
          const incDoc = ((upd.u as any)?.$inc) as MongoDoc | undefined;
          let matched = false;
          for (const doc of coll) {
            if (matchesFilter(doc, filter)) {
              if (setDoc) Object.assign(doc, setDoc);
              if (unsetDoc) { for (const k of Object.keys(unsetDoc)) delete doc[k]; }
              if (incDoc) { for (const [k, v] of Object.entries(incDoc)) (doc as any)[k] = ((doc as any)[k] ?? 0) + (v as number); }
              nModified++;
              matched = true;
              if (!upd.multi) break;
            }
          }
          if (!matched && upd.upsert) {
            const newDoc = { _id: this._idCounter++, ...filter, ...setDoc };
            coll.push(newDoc);
            nUpserted++;
          }
        }
        return { n: nModified + nUpserted, nModified, ok: 1 };
      }

      case 'delete': {
        const collName = cmd.delete as string;
        const deletes = (cmd.deletes ?? []) as Array<{ q: MongoDoc; limit?: number }>;
        const coll = this.getCollection(dbName, collName);
        let n = 0;
        for (const del of deletes) {
          const filter = del.q ?? {};
          const limit = del.limit ?? 0; // 0 = all
          let deleted = 0;
          const remaining: MongoDoc[] = [];
          for (const doc of coll) {
            if ((limit === 0 || deleted < limit) && matchesFilter(doc, filter)) {
              deleted++;
              n++;
            } else {
              remaining.push(doc);
            }
          }
          coll.splice(0, coll.length, ...remaining);
        }
        return { n, ok: 1 };
      }

      case 'getMore':
        // We return all data in firstBatch, so getMore always returns empty
        return {
          cursor: { id: 0, ns: `${dbName}`, nextBatch: [] as unknown as BsonValue },
          ok: 1,
        };

      default:
        throw new SimNodeUnsupportedMongoFeature(cmdName);
    }
  }

  reset(): void {
    this._dbs.clear();
    this._idCounter = 1;
  }
}

// Simple filter matching (supports: equality, $gt, $lt, $gte, $lte, $ne, $in, $exists)
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

// ---------------------------------------------------------------------------
// MongoConnection — stateful per-connection handler
// ---------------------------------------------------------------------------

class MongoConnection {
  // Buffer for partial frames
  private _buf = Buffer.alloc(0);

  constructor(private _store: MongoStore, private _defaultDb: string) {}

  /**
   * Process incoming raw TCP data.
   * Returns one or more response frames.
   */
  processData(data: Buffer): Buffer | null {
    this._buf = Buffer.concat([this._buf, data]);
    const responses: Buffer[] = [];

    while (this._buf.length >= 16) {
      const msgLen = this._buf.readInt32LE(0);
      if (this._buf.length < msgLen) break;

      const frame = parseFrame(this._buf);
      this._buf = this._buf.slice(msgLen);

      if (!frame) continue;

      try {
        const resp = this._handleFrame(frame);
        if (resp) responses.push(resp);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (frame.opCode === OP_MSG) {
          responses.push(buildOpMsg(999, frame.requestId, {
            ok: 0,
            errmsg: errMsg,
            code: 1,
            codeName: 'SimNodeError',
          }));
        }
      }
    }

    return responses.length > 0 ? Buffer.concat(responses) : null;
  }

  private _handleFrame(frame: MsgFrame): Buffer | null {
    if (frame.opCode === OP_MSG) {
      const doc = parseOpMsg(frame.body);
      // $db is the database name (MongoDB 3.6+ always includes it)
      const dbName = (doc.$db as string) ?? this._defaultDb;
      const result = this._store.execCommand(dbName, doc);
      return buildOpMsg(999, frame.requestId, result);
    }

    if (frame.opCode === OP_QUERY) {
      // Legacy handshake (isMaster, hello) from old drivers
      const { query } = parseOpQuery(frame.body);
      const cmdKey = Object.keys(query)[0] ?? 'isMaster';
      const dbName = this._defaultDb;
      const result = this._store.execCommand(dbName, { [cmdKey]: 1, ...query });
      return buildOpReply(frame.requestId, result);
    }

    // Ignore other opcodes (OP_COMPRESSED etc.)
    return null;
  }
}

// ---------------------------------------------------------------------------
// MongoMock — public API
// ---------------------------------------------------------------------------

export class MongoMock {
  readonly store: MongoStore;
  private _connections = new Map<number, MongoConnection>();
  private _defaultDb: string;

  constructor(opts?: { defaultDb?: string }) {
    this.store = new MongoStore();
    this._defaultDb = opts?.defaultDb ?? 'test';
  }

  seedData(db: string, collection: string, docs: MongoDoc[]): void {
    this.store.seedData(db, collection, docs);
  }

  reset(): void {
    this.store.reset();
    this._connections.clear();
  }

  createHandler(): TcpMockHandler {
    const defaultDb = this._defaultDb;
    const connections = this._connections;
    const store = this.store;

    return (data: Buffer, ctx: TcpMockContext): TcpHandlerResult => {
      if (!connections.has(ctx.socketId)) {
        connections.set(ctx.socketId, new MongoConnection(store, defaultDb));
      }
      const conn = connections.get(ctx.socketId)!;
      const response = conn.processData(data);
      return response ?? null;
    };
  }
}
