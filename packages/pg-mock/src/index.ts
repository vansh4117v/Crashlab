import type { TcpMockHandler, TcpMockContext, TcpHandlerResult } from '@simnode/tcp';
import * as proto from './protocol.js';

export class SimNodeUnsupportedPGFeature extends Error {
  constructor(detail: string) {
    super(`SimNode: Unsupported PostgreSQL feature: ${detail}`);
    this.name = 'SimNodeUnsupportedPGFeature';
  }
}

// ── PgStore ───────────────────────────────────────────────────────────────────
// Kept for direct sync access (used by scheduler-level tests and legacy code).
// Wire-protocol connections now go through PGlite instead.

type Row = Record<string, string | null>;

export class PgStore {
  private _tables = new Map<string, Row[]>();

  seedData(table: string, rows: Row[]): void {
    this._tables.set(table.toLowerCase(), rows.map(r => ({ ...r })));
  }

  getTable(name: string): Row[] {
    return this._tables.get(name.toLowerCase()) ?? [];
  }

  execSQL(sql: string): { tag: string; columns?: string[]; rows?: (string | null)[][] } {
    const trimmed = sql.trim();
    const upper = trimmed.toUpperCase();

    if (upper === 'BEGIN') return { tag: 'BEGIN' };
    if (upper === 'COMMIT') return { tag: 'COMMIT' };
    if (upper === 'ROLLBACK') return { tag: 'ROLLBACK' };

    const litMatch = trimmed.match(/^SELECT\s+(.+)$/i);
    if (litMatch && !upper.includes(' FROM ')) {
      const expr = litMatch[1].replace(/;$/, '').trim();
      const vals = expr.split(',').map(v => v.trim().replace(/^'|'$/g, ''));
      const cols = vals.map((_, i) => vals.length === 1 ? '?column?' : `col${i + 1}`);
      return { tag: 'SELECT 1', columns: cols, rows: [vals] };
    }

    const selMatch = trimmed.match(/^SELECT\s+(.+?)\s+FROM\s+(\w+)(?:\s+WHERE\s+(.+))?;?$/i);
    if (selMatch) {
      const colExpr = selMatch[1].trim();
      const table = selMatch[2];
      const where = selMatch[3];
      let rows = this.getTable(table);
      if (where) rows = rows.filter(r => this._matchesWhere(r, where));
      const cols = colExpr === '*'
        ? (rows.length > 0 ? Object.keys(rows[0]) : [])
        : colExpr.split(',').map(c => c.trim());
      const data = rows.map(r => cols.map(c => r[c] ?? null));
      return { tag: `SELECT ${data.length}`, columns: cols, rows: data };
    }

    const insMatch = trimmed.match(/^INSERT\s+INTO\s+(\w+)\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\);?$/i);
    if (insMatch) {
      const table = insMatch[1];
      const cols = insMatch[2].split(',').map(c => c.trim());
      const vals = insMatch[3].split(',').map(v => v.trim().replace(/^'|'$/g, ''));
      const row: Row = {};
      cols.forEach((c, i) => { row[c] = vals[i] ?? null; });
      const existing = this._tables.get(table.toLowerCase()) ?? [];
      existing.push(row);
      this._tables.set(table.toLowerCase(), existing);
      return { tag: 'INSERT 0 1' };
    }

    const updMatch = trimmed.match(/^UPDATE\s+(\w+)\s+SET\s+(.+?)\s+WHERE\s+(.+?);?$/i);
    if (updMatch) {
      const sets = this._parseAssignments(updMatch[2]);
      const rows = this.getTable(updMatch[1]);
      let count = 0;
      for (const r of rows) {
        if (this._matchesWhere(r, updMatch[3])) {
          for (const [k, v] of Object.entries(sets)) r[k] = v;
          count++;
        }
      }
      return { tag: `UPDATE ${count}` };
    }

    const delMatch = trimmed.match(/^DELETE\s+FROM\s+(\w+)\s+WHERE\s+(.+?);?$/i);
    if (delMatch) {
      const tName = delMatch[1].toLowerCase();
      const rows = this._tables.get(tName) ?? [];
      const remaining = rows.filter(r => !this._matchesWhere(r, delMatch[2]));
      this._tables.set(tName, remaining);
      return { tag: `DELETE ${rows.length - remaining.length}` };
    }

    throw new SimNodeUnsupportedPGFeature(sql);
  }

  private _matchesWhere(row: Row, where: string): boolean {
    const m = where.match(/^(\w+)\s*=\s*(.+)$/);
    if (!m) return false;
    return row[m[1].trim()] === m[2].trim().replace(/^'|'$/g, '');
  }

  private _parseAssignments(expr: string): Record<string, string> {
    const result: Record<string, string> = {};
    for (const part of expr.split(',')) {
      const [k, v] = part.split('=').map(s => s.trim());
      result[k] = (v ?? '').replace(/^'|'$/g, '');
    }
    return result;
  }
}

// ── PGlite helpers ────────────────────────────────────────────────────────────

// Dynamically imported so the package remains optional at load time.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PGliteInstance = any;

function createPGliteInstance(): Promise<PGliteInstance> {
  return import('@electric-sql/pglite').then(({ PGlite }) => new PGlite());
}

/** Infer a PostgreSQL command tag from the SQL statement and affected-row count. */
function inferTag(sql: string, rowCount: number, affected?: number): string {
  const verb = sql.trim().split(/\s+/)[0]?.toUpperCase() ?? '';
  switch (verb) {
    case 'SELECT': return `SELECT ${rowCount}`;
    case 'INSERT': return `INSERT 0 ${affected ?? rowCount}`;
    case 'UPDATE': return `UPDATE ${affected ?? rowCount}`;
    case 'DELETE': return `DELETE ${affected ?? rowCount}`;
    case 'CREATE': return 'CREATE TABLE';
    case 'DROP':   return 'DROP TABLE';
    case 'BEGIN':  return 'BEGIN';
    case 'COMMIT': return 'COMMIT';
    case 'ROLLBACK': return 'ROLLBACK';
    default:       return verb;
  }
}

// ── PgConnection ──────────────────────────────────────────────────────────────

class PgConnection {
  private _phase: 'startup' | 'ready' = 'startup';
  private _txState: 'I' | 'T' | 'E' = 'I';

  constructor(private _pglite: Promise<PGliteInstance>) {}

  async processData(data: Buffer): Promise<Buffer> {
    // ── Startup / SSL handshake ───────────────────────────────────────────────
    if (this._phase === 'startup') {
      const parsed = proto.parseStartupMsg(data);
      if ('isSSL' in parsed) return Buffer.from('N');
      this._phase = 'ready';
      return proto.startupResponse();
    }

    // ── Simple Query ('Q') ────────────────────────────────────────────────────
    if (data[0] === 0x51) {
      const sql = proto.parseQueryMsg(data);
      return this._execQuery(sql);
    }

    // ── Extended protocol (Parse/Bind/Execute/Sync) ───────────────────────────
    // Process a multi-message pipeline; collect all responses and flush at Sync.
    const responses: Buffer[] = [];
    let offset = 0;

    while (offset < data.length) {
      const msgType = String.fromCharCode(data[offset]);
      const msgLen  = data.readInt32BE(offset + 1);
      const payload = data.slice(offset + 5, offset + 1 + msgLen);
      offset += 1 + msgLen;

      switch (msgType) {
        case 'P': { // Parse
          responses.push(proto.parseComplete());
          break;
        }
        case 'B': { // Bind
          responses.push(proto.bindComplete());
          break;
        }
        case 'D': { // Describe
          responses.push(proto.noData());
          break;
        }
        case 'E': { // Execute
          const sql = proto.parseExecuteMsg(payload);
          if (sql) {
            const r = await this._execQuery(sql);
            responses.push(r);
          }
          break;
        }
        case 'S': { // Sync
          responses.push(proto.readyForQuery(this._txState));
          break;
        }
        default:
          // Silently ignore unknown message types
          break;
      }
    }

    return responses.length > 0 ? Buffer.concat(responses) : proto.readyForQuery(this._txState);
  }

  private async _execQuery(sql: string): Promise<Buffer> {
    const trimmed = sql.trim();
    const upper   = trimmed.toUpperCase();

    if (upper === 'BEGIN')    { this._txState = 'T'; return Buffer.concat([proto.commandComplete('BEGIN'),    proto.readyForQuery('T')]); }
    if (upper === 'COMMIT')   { this._txState = 'I'; return Buffer.concat([proto.commandComplete('COMMIT'),   proto.readyForQuery('I')]); }
    if (upper === 'ROLLBACK') { this._txState = 'I'; return Buffer.concat([proto.commandComplete('ROLLBACK'), proto.readyForQuery('I')]); }

    const db = await this._pglite;
    try {
      const result = await db.query(trimmed);
      const fields: Array<{ name: string }> = result.fields ?? [];
      const rows:   Array<Record<string, unknown>> = result.rows  ?? [];

      const bufs: Buffer[] = [];

      if (fields.length > 0) {
        bufs.push(proto.rowDescription(fields.map((f: { name: string }) => f.name)));
        for (const row of rows) {
          bufs.push(proto.dataRow(fields.map((f: { name: string }) => {
            const v = row[f.name];
            return v === null || v === undefined ? null : String(v);
          })));
        }
      }

      const tag = inferTag(trimmed, rows.length, result.affectedRows as number | undefined);
      if (tag === 'BEGIN') this._txState = 'T';
      else if (tag === 'COMMIT' || tag === 'ROLLBACK') this._txState = 'I';

      bufs.push(proto.commandComplete(tag));
      bufs.push(proto.readyForQuery(this._txState));
      return Buffer.concat(bufs);
    } catch (err) {
      return Buffer.concat([
        proto.errorResponse(err instanceof Error ? err.message : String(err)),
        proto.readyForQuery(this._txState === 'T' ? 'E' : 'I'),
      ]);
    }
  }
}

// ── PgMock ────────────────────────────────────────────────────────────────────

export class PgMock {
  /** Legacy sync store — retained for direct scheduler-level test access. */
  readonly store: PgStore;

  /** Shared PGlite instance (one per PgMock, lazy-initialised). */
  private _pglite: Promise<PGliteInstance>;
  /** Tracks all in-flight seed operations so ready() can await them. */
  private _seedPromise: Promise<void> = Promise.resolve();
  private _connections = new Map<number, PgConnection>();

  constructor() {
    this.store  = new PgStore();
    this._pglite = createPGliteInstance();
  }

  /**
   * Resolves once PGlite is initialised AND all pending seedData() calls have
   * been mirrored into PGlite.  Await this before making wire-protocol queries
   * in tests that call seedData().
   */
  async ready(): Promise<void> {
    await this._pglite;
    await this._seedPromise;
  }

  /**
   * Seed data into BOTH the legacy PgStore (sync access) AND PGlite (wire protocol).
   * Creates a simple text-column table with the supplied rows.
   */
  seedData(table: string, rows: Array<Record<string, string | null>>): void {
    this.store.seedData(table, rows);
    // Chain onto _seedPromise so ready() waits for ALL seed operations in order.
    this._seedPromise = this._seedPromise.then(() => this._seedPGlite(table, rows));
  }

  private async _seedPGlite(table: string, rows: Array<Record<string, string | null>>): Promise<void> {
    if (rows.length === 0) return;
    const db = await this._pglite;
    const cols = Object.keys(rows[0]);
    const colDefs = cols.map(c => `"${c}" TEXT`).join(', ');
    try {
      await db.exec(`CREATE TABLE IF NOT EXISTS "${table}" (${colDefs})`);
      for (const row of rows) {
        const vals = cols.map(c => row[c] === null ? 'NULL' : `'${String(row[c]).replace(/'/g, "''")}'`).join(', ');
        await db.exec(`INSERT INTO "${table}" (${cols.map(c => `"${c}"`).join(', ')}) VALUES (${vals})`);
      }
    } catch {
      // Ignore duplicate table errors on repeated seeding
    }
  }

  /**
   * Execute a raw SQL query against the embedded PGlite instance.
   * Returns rows as plain objects keyed by column name.
   */
  async query<T = Record<string, unknown>>(sql: string): Promise<{ rows: T[]; fields: Array<{ name: string }> }> {
    const db = await this._pglite;
    return db.query(sql) as Promise<{ rows: T[]; fields: Array<{ name: string }> }>;
  }

  createHandler(): TcpMockHandler {
    return async (data: Buffer, ctx: TcpMockContext): Promise<TcpHandlerResult> => {
      if (!this._connections.has(ctx.socketId)) {
        this._connections.set(ctx.socketId, new PgConnection(this._pglite));
      }
      return this._connections.get(ctx.socketId)!.processData(data);
    };
  }
}

export { proto };
