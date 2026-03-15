import type { TcpMockHandler, TcpHandlerResult } from '@simnode/tcp';

export class SimNodeUnsupportedRedisCommand extends Error {
  constructor(cmd: string) {
    super(`SimNode: Unsupported Redis command: ${cmd}`);
    this.name = 'SimNodeUnsupportedRedisCommand';
  }
}

// RESP encoder
function respOk(): Buffer { return Buffer.from('+OK\r\n'); }
function respErr(msg: string): Buffer { return Buffer.from(`-ERR ${msg}\r\n`); }
function respInt(n: number): Buffer { return Buffer.from(`:${n}\r\n`); }
function respBulk(s: string | null): Buffer {
  if (s === null) return Buffer.from('$-1\r\n');
  return Buffer.from(`$${Buffer.byteLength(s)}\r\n${s}\r\n`);
}
function respArray(items: Buffer[]): Buffer {
  return Buffer.concat([Buffer.from(`*${items.length}\r\n`), ...items]);
}

// RESP parser: parse one command (array of bulk strings)
function parseRESP(data: Buffer): string[][] {
  const text = data.toString('utf8');
  const lines = text.split('\r\n');
  const commands: string[][] = [];
  let i = 0;
  while (i < lines.length) {
    if (!lines[i].startsWith('*')) {
      // Inline command
      const parts = lines[i].trim().split(/\s+/);
      if (parts[0]) commands.push(parts);
      i++;
      continue;
    }
    const argc = parseInt(lines[i].slice(1));
    if (isNaN(argc) || argc <= 0) { i++; continue; }
    const args: string[] = [];
    i++;
    for (let a = 0; a < argc && i < lines.length; a++) {
      if (lines[i].startsWith('$')) {
        i++; // skip length line
        args.push(lines[i] ?? '');
        i++;
      } else {
        args.push(lines[i]); i++;
      }
    }
    if (args.length) commands.push(args);
  }
  return commands;
}

interface IClock { now(): number; }

interface RedisEntry {
  type: string;
  value: unknown;
  expireAt?: number;
}

export class RedisMock {
  private _data = new Map<string, RedisEntry>();
  private _clock?: IClock;

  constructor(opts?: { clock?: IClock }) { this._clock = opts?.clock; }

  seedData(key: string, value: string): void {
    this._data.set(key, { type: 'string', value });
  }

  private _now(): number { return this._clock?.now() ?? Date.now(); }

  private _get(key: string): RedisEntry | undefined {
    const entry = this._data.get(key);
    if (!entry) return undefined;
    if (entry.expireAt !== undefined && entry.expireAt <= this._now()) {
      this._data.delete(key);
      return undefined;
    }
    return entry;
  }

  private _execCmd(args: string[]): Buffer {
    const cmd = args[0].toUpperCase();
    const k = args[1];

    switch (cmd) {
      case 'PING': return Buffer.from('+PONG\r\n');
      case 'GET': {
        const e = this._get(k);
        return respBulk(e ? String(e.value) : null);
      }
      case 'SET': {
        this._data.set(k, { type: 'string', value: args[2] ?? '' });
        // Handle EX/NX
        for (let i = 3; i < args.length; i++) {
          const flag = args[i].toUpperCase();
          if (flag === 'EX' && args[i + 1]) {
            this._data.get(k)!.expireAt = this._now() + parseInt(args[i + 1]) * 1000;
            i++;
          } else if (flag === 'PX' && args[i + 1]) {
            this._data.get(k)!.expireAt = this._now() + parseInt(args[i + 1]);
            i++;
          } else if (flag === 'NX') {
            // Already set above; for true NX we'd check first, but this is minimal
          }
        }
        return respOk();
      }
      case 'DEL': {
        let count = 0;
        for (let i = 1; i < args.length; i++) { if (this._data.delete(args[i])) count++; }
        return respInt(count);
      }
      case 'EXPIRE': {
        const e = this._get(k);
        if (!e) return respInt(0);
        e.expireAt = this._now() + parseInt(args[2]) * 1000;
        return respInt(1);
      }
      case 'TTL': {
        const e = this._get(k);
        if (!e) return respInt(-2);
        if (e.expireAt === undefined) return respInt(-1);
        return respInt(Math.max(0, Math.ceil((e.expireAt - this._now()) / 1000)));
      }
      case 'INCR': {
        const e = this._get(k);
        const val = e ? parseInt(String(e.value)) + 1 : 1;
        this._data.set(k, { type: 'string', value: String(val) });
        return respInt(val);
      }
      case 'DECR': {
        const e = this._get(k);
        const val = e ? parseInt(String(e.value)) - 1 : -1;
        this._data.set(k, { type: 'string', value: String(val) });
        return respInt(val);
      }
      case 'LPUSH': case 'RPUSH': {
        const e = this._get(k);
        const list: string[] = e ? (e.value as string[]) : [];
        for (let i = 2; i < args.length; i++) {
          cmd === 'LPUSH' ? list.unshift(args[i]) : list.push(args[i]);
        }
        this._data.set(k, { type: 'list', value: list });
        return respInt(list.length);
      }
      case 'LPOP': case 'RPOP': {
        const e = this._get(k);
        if (!e) return respBulk(null);
        const list = e.value as string[];
        const v = cmd === 'LPOP' ? list.shift() : list.pop();
        return respBulk(v ?? null);
      }
      case 'HSET': {
        const e = this._get(k);
        const hash: Record<string, string> = e ? (e.value as Record<string, string>) : {};
        let added = 0;
        for (let i = 2; i < args.length; i += 2) {
          if (!(args[i] in hash)) added++;
          hash[args[i]] = args[i + 1] ?? '';
        }
        this._data.set(k, { type: 'hash', value: hash });
        return respInt(added);
      }
      case 'HGET': {
        const e = this._get(k);
        if (!e) return respBulk(null);
        return respBulk((e.value as Record<string, string>)[args[2]] ?? null);
      }
      case 'SMEMBERS': {
        const e = this._get(k);
        if (!e) return respArray([]);
        const set = e.value as Set<string>;
        return respArray([...set].map(s => respBulk(s)));
      }
      case 'SADD': {
        const e = this._get(k);
        const set: Set<string> = e ? (e.value as Set<string>) : new Set();
        let added = 0;
        for (let i = 2; i < args.length; i++) { if (!set.has(args[i])) { set.add(args[i]); added++; } }
        this._data.set(k, { type: 'set', value: set });
        return respInt(added);
      }
      case 'ZADD': {
        const e = this._get(k);
        const zset: [number, string][] = e ? (e.value as [number, string][]) : [];
        let added = 0;
        for (let i = 2; i < args.length; i += 2) {
          const score = parseFloat(args[i]);
          const member = args[i + 1];
          const idx = zset.findIndex(z => z[1] === member);
          if (idx >= 0) { zset[idx][0] = score; } else { zset.push([score, member]); added++; }
        }
        zset.sort((a, b) => a[0] - b[0]);
        this._data.set(k, { type: 'zset', value: zset });
        return respInt(added);
      }
      case 'ZRANGE': {
        const e = this._get(k);
        if (!e) return respArray([]);
        const zset = e.value as [number, string][];
        const start = parseInt(args[2]); const stop = parseInt(args[3]);
        const slice = zset.slice(start, stop < 0 ? undefined : stop + 1);
        return respArray(slice.map(z => respBulk(z[1])));
      }
      default:
        throw new SimNodeUnsupportedRedisCommand(cmd);
    }
  }

  createHandler(): TcpMockHandler {
    return (data: Buffer): TcpHandlerResult => {
      const commands = parseRESP(data);
      if (commands.length === 0) return null;
      const responses = commands.map(cmd => this._execCmd(cmd));
      return Buffer.concat(responses);
    };
  }
}
