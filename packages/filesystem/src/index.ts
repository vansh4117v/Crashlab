import { createRequire } from 'node:module';
import * as path from 'node:path';
import { normalizePath } from './internalPaths.js';

const _require = createRequire(import.meta.url);
const fsCjs = _require('node:fs') as typeof import('node:fs');

interface VFSEntry { content: Buffer; isDir: boolean }
interface InjectedError { error: string; code: string; after?: number }

interface FileDescriptor {
  id: number;
  normPath: string;
  position: number;
  flags: string;
}

export class VirtualFS {
  private _store = new Map<string, VFSEntry>();
  private _injections = new Map<string, InjectedError>();
  private _originals: Record<string, unknown> = {};
  private _writeCount = new Map<string, number>();
  
  private _fdTable = new Map<number, FileDescriptor>();
  private _nextFd = 1000;

  seed(files: Record<string, string | Buffer>): void {
    for (const [p, content] of Object.entries(files)) {
      const norm = normalizePath(p);
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
    this._injections.set(normalizePath(filePath), { error: opts.error, code: opts.code ?? 'EIO', after: opts.after });
  }

  private _checkInjection(p: string, op: 'read' | 'write'): void {
    const norm = normalizePath(p);
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
  
  private _getStat(norm: string) {
      const entry = this._store.get(norm);
      if (!entry) { const err = new Error(`ENOENT: no such file or directory, stat '${norm}'`) as NodeJS.ErrnoException; err.code = 'ENOENT'; throw err; }
      return {
        isFile: () => !entry.isDir,
        isDirectory: () => entry.isDir,
        isSymbolicLink: () => false,
        size: entry.content.length,
        mtimeMs: 0,
        mtime: new Date(0),
        atimeMs: 0,
        atime: new Date(0),
        ctimeMs: 0,
        ctime: new Date(0),
        birthtimeMs: 0,
        birthtime: new Date(0),
      };
  }

  install(): void {
    const self = this;
    
    // Save originals
    const origNames = [
      'readFileSync', 'writeFileSync', 'existsSync', 'mkdirSync', 'readdirSync', 
      'unlinkSync', 'statSync', 'openSync', 'closeSync', 'fstatSync', 'readSync', 'writeSync',
      'readFile', 'writeFile', 'open', 'close', 'fstat', 'stat',
    ];
    for(const k of origNames) {
        if (k in fsCjs) this._originals[k] = (fsCjs as any)[k];
    }
    
    if (fsCjs.promises) {
        this._originals['promises.readFile'] = fsCjs.promises.readFile;
        this._originals['promises.writeFile'] = fsCjs.promises.writeFile;
        this._originals['promises.open'] = fsCjs.promises.open;
        this._originals['promises.stat'] = fsCjs.promises.stat;
    }

    // --- SYNC VARIANTS --- //

    (fsCjs as any).readFileSync = function (p: string | Buffer | URL | number, opts?: any): string | Buffer {
      if (typeof p === 'number') {
        const fd = self._fdTable.get(p);
        if (!fd) throw new Error('EBADF: bad file descriptor');
        p = fd.normPath;
      }
      const norm = normalizePath(String(p));
      self._checkInjection(norm, 'read');
      const entry = self._store.get(norm);
      if (!entry || entry.isDir) {
        const err = new Error(`ENOENT: no such file: '${p}'`) as NodeJS.ErrnoException;
        err.code = 'ENOENT'; throw err;
      }
      if (opts?.encoding || typeof opts === 'string') return entry.content.toString(typeof opts === 'string' ? opts : opts.encoding);
      return Buffer.from(entry.content);
    };

    (fsCjs as any).writeFileSync = function (p: string | Buffer | URL | number, data: string | Buffer): void {
      if (typeof p === 'number') {
        const fd = self._fdTable.get(p);
        if (!fd) throw new Error('EBADF: bad file descriptor');
        p = fd.normPath;
      }
      const norm = normalizePath(String(p));
      self._checkInjection(norm, 'write');
      self._store.set(norm, { content: Buffer.isBuffer(data) ? data : Buffer.from(data), isDir: false });
    };

    (fsCjs as any).existsSync = function (p: string): boolean {
      return self._store.has(normalizePath(String(p)));
    };

    (fsCjs as any).mkdirSync = function (p: string, opts?: any): void {
      const norm = normalizePath(String(p));
      self._store.set(norm, { content: Buffer.alloc(0), isDir: true });
    };

    (fsCjs as any).readdirSync = function (p: string): string[] {
      const norm = normalizePath(String(p));
      const result: string[] = [];
      for (const key of self._store.keys()) {
        if (path.dirname(key) === norm && key !== norm) result.push(path.basename(key));
      }
      return result;
    };

    (fsCjs as any).unlinkSync = function (p: string): void {
      const norm = normalizePath(String(p));
      if (!self._store.delete(norm)) {
        const err = new Error(`ENOENT: '${p}'`) as NodeJS.ErrnoException;
        err.code = 'ENOENT'; throw err;
      }
    };

    (fsCjs as any).statSync = function (p: string): any {
      const norm = normalizePath(String(p));
      return self._getStat(norm);
    };
    
    // FD table abstractions
    (fsCjs as any).openSync = function (p: string, flags: string, mode?: any): number {
        const norm = normalizePath(String(p));
        const entry = self._store.get(norm);
        
        const isWrite = flags.includes('w') || flags.includes('a');
        
        if (!entry && !isWrite) {
            const err = new Error(`ENOENT: no such file or directory, open '${p}'`) as NodeJS.ErrnoException;
            err.code = 'ENOENT'; throw err;
        }
        
        if (!entry && isWrite) {
            self._store.set(norm, { content: Buffer.alloc(0), isDir: false });
        } else if (entry && flags.includes('w')) {
            // truncate
            entry.content = Buffer.alloc(0);
        }
        
        const fd = self._nextFd++;
        self._fdTable.set(fd, { id: fd, normPath: norm, position: 0, flags });
        return fd;
    };
    
    (fsCjs as any).closeSync = function (fd: number): void {
        if (!self._fdTable.has(fd)) {
            const err = new Error(`EBADF: bad file descriptor, close`) as NodeJS.ErrnoException;
            err.code = 'EBADF'; throw err;
        }
        self._fdTable.delete(fd);
    };
    
    (fsCjs as any).fstatSync = function (fd: number): any {
        const fdObj = self._fdTable.get(fd);
        if (!fdObj) {
           const err = new Error(`EBADF: bad file descriptor, fstat`) as NodeJS.ErrnoException;
           err.code = 'EBADF'; throw err;
        }
        return self._getStat(fdObj.normPath);
    };

    // --- CALLBACK VARIANTS --- //
    
    (fsCjs as any).readFile = function (p: any, opts: any, cb: any): void {
        let callback = cb || opts;
        let options = typeof opts === 'function' ? null : opts;
        queueMicrotask(() => {
            try {
                const res = fsCjs.readFileSync(p, options);
                callback(null, res);
            } catch(e) {
                callback(e);
            }
        });
    };
    
    (fsCjs as any).writeFile = function (p: any, data: any, opts: any, cb: any): void {
        let callback = cb || opts;
        let options = typeof opts === 'function' ? null : opts;
        queueMicrotask(() => {
            try {
                fsCjs.writeFileSync(p, data);
                callback(null);
            } catch(e) {
                callback(e);
            }
        });
    };
    
    (fsCjs as any).stat = function (p: any, opts: any, cb: any): void {
        let callback = cb || opts;
        queueMicrotask(() => {
            try {
                const res = fsCjs.statSync(p);
                callback(null, res);
            } catch(e) {
                callback(e);
            }
        });
    };
    
    (fsCjs as any).open = function (p: any, flags: any, mode: any, cb: any): void {
        let callback = cb || mode || flags;
        let f = typeof flags === 'function' ? 'r' : flags;
        queueMicrotask(() => {
            try {
                const res = fsCjs.openSync(p, f);
                callback(null, res);
            } catch(e) {
                callback(e);
            }
        });
    };
    
    (fsCjs as any).close = function (fd: number, cb: any): void {
         queueMicrotask(() => {
          try {
              fsCjs.closeSync(fd);
              if(cb) cb(null);
          } catch(e) {
              if(cb) cb(e);
          }
       });
    };
    
    (fsCjs as any).fstat = function (fd: number, opts: any, cb: any): void {
        let callback = cb || opts;
        queueMicrotask(() => {
            try {
                const res = fsCjs.fstatSync(fd);
                callback(null, res);
            } catch(e) {
                callback(e);
            }
        });
    };

    // --- PROMISES --- //
    
    if (fsCjs.promises) {
        (fsCjs.promises as any).readFile = function(p: any, opts: any) {
            return new Promise((resolve, reject) => {
                fsCjs.readFile(p, opts, (err: any, data: any) => err ? reject(err) : resolve(data));
            });
        };
        (fsCjs.promises as any).writeFile = function(p: any, data: any, opts: any) {
            return new Promise((resolve, reject) => {
                fsCjs.writeFile(p, data, opts, (err: any) => err ? reject(err) : resolve(undefined));
            });
        };
        (fsCjs.promises as any).stat = function(p: any, opts?: any) {
            return new Promise((resolve, reject) => {
                fsCjs.stat(p, opts, (err: any, data: any) => err ? reject(err) : resolve(data));
            });
        };
        (fsCjs.promises as any).open = function(p: any, flags: any, mode?: any) {
            return new Promise((resolve, reject) => {
                fsCjs.open(p, flags, mode, (err: any, fd: any) => {
                    if (err) return reject(err);
                    
                    // Return a FileHandle mock
                    resolve({
                        fd,
                        stat: () => fsCjs.promises.stat(p),
                        readFile: (opts: any) => fsCjs.promises.readFile(fd, opts),
                        writeFile: (data: any, opts: any) => fsCjs.promises.writeFile(fd, data, opts),
                        close: () => new Promise<void>((r, rj) => fsCjs.close(fd, (ce: any) => ce ? rj(ce) : r()))
                    });
                });
            });
        };
    }
  }

  uninstall(): void {
    for (const [name, orig] of Object.entries(this._originals)) {
        if (name.startsWith('promises.')) {
            if (fsCjs.promises) (fsCjs.promises as any)[name.replace('promises.', '')] = orig;
        } else {
            (fsCjs as any)[name] = orig;
        }
    }
    this._originals = {};
  }

  reset(): void {
    this._store.clear();
    this._injections.clear();
    this._writeCount.clear();
    this._fdTable.clear();
    this._nextFd = 1000;
  }
}
