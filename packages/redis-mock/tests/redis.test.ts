import { describe, it, expect } from 'vitest';
import { RedisMock, SimNodeUnsupportedRedisCommand } from '../src/index.js';
import { VirtualClock } from '@simnode/clock';

function cmd(mock: RedisMock, ...args: string[]): Buffer {
  const handler = mock.createHandler();
  const resp = args.map(a => `$${Buffer.byteLength(a)}\r\n${a}\r\n`).join('');
  const full = `*${args.length}\r\n${resp}`;
  const result = handler(Buffer.from(full), { remoteHost: 'localhost', remotePort: 6379, socketId: 0 });
  return Buffer.isBuffer(result) ? result : Buffer.concat(result as Buffer[]);
}

describe('Redis commands', () => {
  it('PING → PONG', () => {
    const mock = new RedisMock();
    expect(cmd(mock, 'PING').toString()).toBe('+PONG\r\n');
  });

  it('GET/SET', () => {
    const mock = new RedisMock();
    cmd(mock, 'SET', 'key1', 'hello');
    expect(cmd(mock, 'GET', 'key1').toString()).toContain('hello');
  });

  it('DEL', () => {
    const mock = new RedisMock();
    cmd(mock, 'SET', 'k', 'v');
    const r = cmd(mock, 'DEL', 'k');
    expect(r.toString()).toBe(':1\r\n');
    expect(cmd(mock, 'GET', 'k').toString()).toBe('$-1\r\n');
  });

  it('INCR/DECR', () => {
    const mock = new RedisMock();
    cmd(mock, 'SET', 'counter', '10');
    expect(cmd(mock, 'INCR', 'counter').toString()).toBe(':11\r\n');
    expect(cmd(mock, 'DECR', 'counter').toString()).toBe(':10\r\n');
    // INCR on non-existent key
    expect(cmd(mock, 'INCR', 'new').toString()).toBe(':1\r\n');
  });

  it('LPUSH/RPUSH/LPOP/RPOP', () => {
    const mock = new RedisMock();
    cmd(mock, 'RPUSH', 'list', 'a');
    cmd(mock, 'RPUSH', 'list', 'b');
    cmd(mock, 'LPUSH', 'list', 'z');
    expect(cmd(mock, 'LPOP', 'list').toString()).toContain('z');
    expect(cmd(mock, 'RPOP', 'list').toString()).toContain('b');
  });

  it('HSET/HGET', () => {
    const mock = new RedisMock();
    cmd(mock, 'HSET', 'user:1', 'name', 'Alice');
    expect(cmd(mock, 'HGET', 'user:1', 'name').toString()).toContain('Alice');
  });

  it('SADD/SMEMBERS', () => {
    const mock = new RedisMock();
    cmd(mock, 'SADD', 'myset', 'a');
    cmd(mock, 'SADD', 'myset', 'b');
    cmd(mock, 'SADD', 'myset', 'a'); // duplicate
    const r = cmd(mock, 'SMEMBERS', 'myset').toString();
    expect(r).toContain('a');
    expect(r).toContain('b');
  });

  it('ZADD/ZRANGE', () => {
    const mock = new RedisMock();
    cmd(mock, 'ZADD', 'zs', '1', 'alice', '2', 'bob', '0.5', 'charlie');
    const r = cmd(mock, 'ZRANGE', 'zs', '0', '-1').toString();
    expect(r).toContain('charlie');
    expect(r).toContain('alice');
    expect(r).toContain('bob');
  });

  it('EXPIRE/TTL with virtual clock', () => {
    const clock = new VirtualClock(0);
    const mock = new RedisMock({ clock });
    cmd(mock, 'SET', 'k', 'v');
    cmd(mock, 'EXPIRE', 'k', '10');
    expect(cmd(mock, 'TTL', 'k').toString()).toBe(':10\r\n');
    clock.advance(5000);
    expect(cmd(mock, 'TTL', 'k').toString()).toBe(':5\r\n');
    clock.advance(5000);
    // Key expired
    expect(cmd(mock, 'GET', 'k').toString()).toBe('$-1\r\n');
  });

  it('seedData', () => {
    const mock = new RedisMock();
    mock.seedData('greeting', 'hello');
    expect(cmd(mock, 'GET', 'greeting').toString()).toContain('hello');
  });

  it('unsupported command throws', () => {
    const mock = new RedisMock();
    const handler = mock.createHandler();
    expect(() => handler(Buffer.from('*1\r\n$4\r\nEVAL\r\n'), { remoteHost: 'localhost', remotePort: 6379, socketId: 0 }))
      .toThrow(SimNodeUnsupportedRedisCommand);
  });
});
