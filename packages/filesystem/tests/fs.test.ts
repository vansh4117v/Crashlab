import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { VirtualFS } from '../src/index.js';

const _require = createRequire(import.meta.url);
const fs = _require('node:fs') as typeof import('node:fs');

let vfs: VirtualFS;
afterEach(() => { vfs?.uninstall(); });

describe('VirtualFS', () => {
  it('readFileSync/writeFileSync', () => {
    vfs = new VirtualFS();
    vfs.seed({ '/tmp/test.txt': 'hello world' });
    vfs.install();
    expect(fs.readFileSync('/tmp/test.txt', 'utf8')).toBe('hello world');
    fs.writeFileSync('/tmp/test.txt', 'updated');
    expect(fs.readFileSync('/tmp/test.txt', 'utf8')).toBe('updated');
  });

  it('existsSync', () => {
    vfs = new VirtualFS();
    vfs.seed({ '/tmp/exists.txt': 'yes' });
    vfs.install();
    expect(fs.existsSync('/tmp/exists.txt')).toBe(true);
    expect(fs.existsSync('/tmp/nope.txt')).toBe(false);
  });

  it('unlinkSync', () => {
    vfs = new VirtualFS();
    vfs.seed({ '/tmp/del.txt': 'bye' });
    vfs.install();
    fs.unlinkSync('/tmp/del.txt');
    expect(fs.existsSync('/tmp/del.txt')).toBe(false);
  });

  it('readFileSync throws ENOENT for missing file', () => {
    vfs = new VirtualFS();
    vfs.install();
    try {
      fs.readFileSync('/nonexistent', 'utf8');
      expect.unreachable();
    } catch (e: any) {
      expect(e.code).toBe('ENOENT');
    }
  });

  it('error injection: ENOSPC on write', () => {
    vfs = new VirtualFS();
    vfs.seed({});
    vfs.inject('/tmp/full.txt', { error: 'no space left', code: 'ENOSPC' });
    vfs.install();
    try {
      fs.writeFileSync('/tmp/full.txt', 'data');
      expect.unreachable();
    } catch (e: any) {
      expect(e.code).toBe('ENOSPC');
    }
  });

  it('error injection with after threshold', () => {
    vfs = new VirtualFS();
    vfs.seed({});
    vfs.inject('/tmp/delayed.txt', { error: 'no space', code: 'ENOSPC', after: 2 });
    vfs.install();
    // First 2 writes succeed
    fs.writeFileSync('/tmp/delayed.txt', 'write1');
    fs.writeFileSync('/tmp/delayed.txt', 'write2');
    // Third write fails
    try {
      fs.writeFileSync('/tmp/delayed.txt', 'write3');
      expect.unreachable();
    } catch (e: any) {
      expect(e.code).toBe('ENOSPC');
    }
  });

  it('statSync', () => {
    vfs = new VirtualFS();
    vfs.seed({ '/tmp/file.txt': 'content' });
    vfs.install();
    const stat = fs.statSync('/tmp/file.txt');
    expect(stat.isFile()).toBe(true);
    expect(stat.isDirectory()).toBe(false);
  });
});
