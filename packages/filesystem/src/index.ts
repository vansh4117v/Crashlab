import { createRequire } from 'node:module';
import * as path from 'node:path';

const _require = createRequire(import.meta.url);
const fsCjs = _require('node:fs') as typeof import('node:fs');

interface VFSEntry { content: Buffer; isDir: boolean }
interface InjectedError { error: string; code: string; after?: number }

export class VirtualFS {
  private _store = new Map<string, VFSEntry>();
  private _injections = new Map<string, InjectedError>();
  private _originals: Record<string, unknown> = {};
  private _writeCount = new Map<string, number>();

  seed(files: Record<string, string | Buffer>): void {
    for (const [p, content] of Object.entries(files)) {
      const norm = path.resolve(p);
      this._store.set(norm, { content: Buffer.isBuffer(content) ? content : Buffer.from(content), isDir: false });
      // Ensure parent dirs exist
      let dir = path.dirname(norm);
      while (dir && dir !== path.dirname(dir)) {
        if (!this._store.has(dir)) this._store.set(dir, { content: Buffer.alloc(0), isDir: true });
        dir = path.dirname(dir);
      }
    }
  }

  inject(filePath: string, opts: { error: string; code?: string; after?: number }): void {
    this._injections.set(path.resolve(filePath), { error: opts.error, code: opts.code ?? 'EIO', after: opts.after });
  }

  private _checkInjection(p: string, op: 'read' | 'write'): void {
    const norm = path.resolve(p);
    const inj = this._injections.get(norm);
    if (!inj) return;
    if (op === 'write') {
      const count = (this._writeCount.get(norm) ?? 0) + 1;
      this._writeCount.set(norm, count);
      if (inj.after !== undefined && count <= inj.after) return;
    }
    const err = new Error(inj.error) as NodeJS.ErrnoException;
    err.code = inj.code;
    err.errno = -1;
    throw err;
  }

  install(): void {
    const self = this;
    this._originals = {
      readFileSync: fsCjs.readFileSync,
      writeFileSync: fsCjs.writeFileSync,
      existsSync: fsCjs.existsSync,
      mkdirSync: fsCjs.mkdirSync,
      readdirSync: fsCjs.readdirSync,
      unlinkSync: fsCjs.unlinkSync,
      statSync: fsCjs.statSync,
    };

    (fsCjs as any).readFileSync = function (p: string, opts?: any): string | Buffer {
      const norm = path.resolve(String(p));
      self._checkInjection(norm, 'read');
      const entry = self._store.get(norm);
      if (!entry || entry.isDir) {
        const err = new Error(`ENOENT: no such file: '${p}'`) as NodeJS.ErrnoException;
        err.code = 'ENOENT'; throw err;
      }
      if (opts?.encoding || typeof opts === 'string') return entry.content.toString(typeof opts === 'string' ? opts : opts.encoding);
      return Buffer.from(entry.content);
    };

    (fsCjs as any).writeFileSync = function (p: string, data: string | Buffer): void {
      const norm = path.resolve(String(p));
      self._checkInjection(norm, 'write');
      self._store.set(norm, { content: Buffer.isBuffer(data) ? data : Buffer.from(data), isDir: false });
    };

    (fsCjs as any).existsSync = function (p: string): boolean {
      return self._store.has(path.resolve(String(p)));
    };

    (fsCjs as any).mkdirSync = function (p: string, opts?: any): void {
      const norm = path.resolve(String(p));
      self._store.set(norm, { content: Buffer.alloc(0), isDir: true });
    };

    (fsCjs as any).readdirSync = function (p: string): string[] {
      const norm = path.resolve(String(p));
      const result: string[] = [];
      for (const key of self._store.keys()) {
        if (path.dirname(key) === norm && key !== norm) result.push(path.basename(key));
      }
      return result;
    };

    (fsCjs as any).unlinkSync = function (p: string): void {
      const norm = path.resolve(String(p));
      if (!self._store.delete(norm)) {
        const err = new Error(`ENOENT: '${p}'`) as NodeJS.ErrnoException;
        err.code = 'ENOENT'; throw err;
      }
    };

    (fsCjs as any).statSync = function (p: string): any {
      const norm = path.resolve(String(p));
      const entry = self._store.get(norm);
      if (!entry) { const err = new Error(`ENOENT: '${p}'`) as NodeJS.ErrnoException; err.code = 'ENOENT'; throw err; }
      return {
        isFile: () => !entry.isDir,
        isDirectory: () => entry.isDir,
        size: entry.content.length,
        mtime: new Date(0),
      };
    };
  }

  uninstall(): void {
    for (const [name, orig] of Object.entries(this._originals)) {
      (fsCjs as any)[name] = orig;
    }
    this._originals = {};
  }

  reset(): void {
    this._store.clear();
    this._injections.clear();
    this._writeCount.clear();
  }
}
