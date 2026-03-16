import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { VirtualFS } from '../src/index.js';
import type * as fsTypes from 'node:fs';
import { createRequire } from 'node:module';
const _require = createRequire(import.meta.url);
const fs = _require('node:fs') as typeof import('node:fs');

describe('Filesystem File Descriptors', () => {
  let vfs: VirtualFS;

  beforeEach(() => {
    vfs = new VirtualFS();
    vfs.seed({
      '/app/file.txt': 'hello',
    });
    vfs.install();
  });

  afterEach(() => {
    vfs.uninstall();
    vfs.reset();
  });

  it('can open, fstat, read, and close via sync fd methods', () => {
    const fd = fs.openSync('/app/file.txt', 'r');
    expect(typeof fd).toBe('number');
    
    // Test fstat
    const stat = fs.fstatSync(fd);
    expect(stat.size).toBe(5);
    expect(stat.isFile()).toBe(true);
    
    // Test readFileSync with FD
    const data = fs.readFileSync(fd, 'utf8');
    expect(data).toBe('hello');
    
    // Test close
    fs.closeSync(fd);
    expect(() => fs.fstatSync(fd)).toThrow(/EBADF/);
  });
  
  it('can write synchronously via fd', () => {
    const fd = fs.openSync('/app/out.txt', 'w');
    fs.writeFileSync(fd, 'world');
    fs.closeSync(fd);
    
    expect(fs.readFileSync('/app/out.txt', 'utf8')).toBe('world');
  });

  it('supports callback fd forms (fstat, close)', async () => {
    const fd = fs.openSync('/app/file.txt', 'r');
    
    const stat = await new Promise<fsTypes.Stats>((resolve, reject) => {
        fs.fstat(fd, (err, s) => err ? reject(err) : resolve(s));
    });
    expect(stat.size).toBe(5);
    
    await new Promise<void>((resolve, reject) => {
        fs.close(fd, (err) => err ? reject(err) : resolve());
    });
    
    expect(() => fs.fstatSync(fd)).toThrow(/EBADF/);
  });
});
