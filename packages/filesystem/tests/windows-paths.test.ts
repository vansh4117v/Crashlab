import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { VirtualFS } from '../src/index.js';
import { createRequire } from 'node:module';
const _require = createRequire(import.meta.url);
const fs = _require('node:fs') as typeof import('node:fs');

describe('Filesystem Windows Paths', () => {
  let vfs: VirtualFS;

  beforeEach(() => {
    vfs = new VirtualFS();
    // Seed using forward slashes
    vfs.seed({
      '/app/build/index.js': 'console.log("hi");',
    });
    vfs.install();
  });

  afterEach(() => {
    vfs.uninstall();
    vfs.reset();
  });

  it('resolves windows backslash paths correctly', () => {
    // Normal backslashes
    const content = fs.readFileSync('\\app\\build\\index.js', 'utf8');
    expect(content).toBe('console.log("hi");');
    
    // Mixed
    expect(fs.existsSync('/app\\build/index.js')).toBe(true);
  });
  
  it('writes to windows backslash paths', () => {
     fs.writeFileSync('\\app\\build\\out.js', 'done');
     // read with forward slash
     expect(fs.readFileSync('/app/build/out.js', 'utf8')).toBe('done');
  });
});
