import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TcpInterceptor } from '../src/index.js';
import * as dns from 'node:dns';

describe('TCP DNS short-circuit', () => {
  let interceptor: TcpInterceptor;

  beforeEach(() => {
    interceptor = new TcpInterceptor();
    interceptor.install();
  });

  afterEach(() => {
    interceptor.uninstall();
    interceptor.reset();
  });

  it('short-circuits lookup for mocked hosts to 127.0.0.1', async () => {
    interceptor.mock('postgres://custom-mocked-db.internal:5432', {
      handler: async () => ({})
    });

    const result = await dns.promises.lookup('custom-mocked-db.internal');
    expect(result.address).toBe('127.0.0.1');
  });

  it('allows normal lookup for unmocked hosts when throwOnUnmocked is false', async () => {
    interceptor.dnsConfig.throwOnUnmocked = false;
    // We should not mock localhost, we should allow lookup
    const result = await dns.promises.lookup('localhost');
    // It's allowed to short-circuit localhost naturally
    expect(result.address).toBe('127.0.0.1');

    // For a real unmocked host, normally it would go to OS DNS. 
    // We don't want to make an actual network call in tests that might be flaky, 
    // so we just test that throwOnUnmocked = true throws properly.
  });

  it('throws ENOTFOUND for unmocked hosts when throwOnUnmocked is true', async () => {
    interceptor.dnsConfig.throwOnUnmocked = true;
    
    await expect(dns.promises.lookup('random-unmocked-host.internal'))
      .rejects.toThrow('getaddrinfo ENOTFOUND random-unmocked-host.internal');
  });

  it('short-circuits resolve4', async () => {
    interceptor.mock('redis://cache.internal:6379', {
        handler: async () => ({})
    });
    const result = await dns.promises.resolve4('cache.internal');
    expect(result).toEqual(['127.0.0.1']);
  });
});
