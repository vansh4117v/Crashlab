import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { VirtualFS } from '../src/index.js';
import * as fs from 'node:fs';

describe('Filesystem Promises', () => {
  let vfs: VirtualFS;

  beforeEach(() => {
    vfs = new VirtualFS();
    vfs.seed({
      '/app/config.json': '{"theme":"dark"}',
    });
    vfs.install();
  });

  afterEach(() => {
    vfs.uninstall();
    vfs.reset();
  });

  it('can readFile and writeFile using promises', async () => {
    const data = await fs.promises.readFile('/app/config.json', 'utf8');
    expect(data).toBe('{"theme":"dark"}');

    await fs.promises.writeFile('/app/config2.json', '{"theme":"light"}', 'utf8');
    const data2 = await fs.promises.readFile('/app/config2.json', 'utf8');
    expect(data2).toBe('{"theme":"light"}');
  });
  
  it('supports FileHandle from fs.promises.open', async () => {
      const handle = await fs.promises.open('/app/config.json', 'r');
      expect(handle).toBeDefined();
      
      const stat = await handle.stat();
      expect(stat.isFile()).toBe(true);
      
      const content = await handle.readFile('utf8');
      expect(content).toBe('{"theme":"dark"}');
      
      await handle.close();
  });
});
