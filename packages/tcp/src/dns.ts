import * as dns from 'node:dns';

// Map of mocked hostnames that should immediately resolve to loopback.
const mockedHosts = new Set<string>();

// Configuration
export const dnsConfig = {
  throwOnUnmocked: false,
};

export function registerMockedHost(hostname: string) {
  mockedHosts.add(hostname);
}

export function clearMockedHosts() {
  mockedHosts.clear();
}

/**
 * Returns true if the hostname is known-mocked or is localhost/loopback.
 * Returns false if we should pass through to the real DNS.
 * Throws ENOTFOUND if `throwOnUnmocked` is set.
 */
function shouldShortCircuit(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') return true;
  if (mockedHosts.has(hostname)) return true;

  if (dnsConfig.throwOnUnmocked) {
    const err = new Error(`getaddrinfo ENOTFOUND ${hostname}`);
    (err as any).code = 'ENOTFOUND';
    (err as any).syscall = 'getaddrinfo';
    (err as any).hostname = hostname;
    throw err;
  }

  return false;
}

// Intercept `dns.lookup` and others
export function patchDns(originals: Record<string, any>) {
  const customLookup = function lookup(hostname: string, options: any, callback?: any) {
    let cb = callback;
    let opts = options;
    if (typeof options === 'function') {
      cb = options;
      opts = {};
    }

    let intercept: boolean;
    try {
      intercept = shouldShortCircuit(hostname);
    } catch (e: any) {
      if (cb) { process.nextTick(() => cb(e)); return {}; }
      return Promise.reject(e);
    }

    if (!intercept) {
      return originals.lookup.apply(dns, [hostname, options, callback]);
    }

    const ip = '127.0.0.1';
    if (cb) {
      process.nextTick(() => {
         if (opts && opts.all) {
           cb(null, [{ address: ip, family: 4 }]);
         } else {
           cb(null, ip, 4);
         }
      });
      return {};
    }
    return Promise.resolve(opts && opts.all ? [{ address: ip, family: 4 }] : { address: ip, family: 4 });
  };

  const customResolve = function resolve(hostname: string, rrtype: any, callback?: any) {
     let cb = callback;
     let type = rrtype;
     if (typeof rrtype === 'function') {
        cb = rrtype;
        type = 'A';
     }

     let intercept: boolean;
     try {
       intercept = shouldShortCircuit(hostname);
     } catch (e: any) {
       if (cb) { process.nextTick(() => cb(e)); return; }
       return Promise.reject(e);
     }

     if (!intercept) {
       return originals.resolve.apply(dns, [hostname, rrtype, callback]);
     }

     const ips = ['127.0.0.1'];
     if (cb) {
        process.nextTick(() => cb(null, ips));
        return;
     }
     return Promise.resolve(ips);
  };

  const customResolve4 = function resolve4(hostname: string, options: any, callback?: any) {
      return customResolve(hostname, 'A', typeof options === 'function' ? options : callback);
  };

  // resolve6 — for unmocked hosts, throw ENOTFOUND so nothing reaches real network
  const customResolve6 = function resolve6(hostname: string, options: any, callback?: any) {
    const cb = typeof options === 'function' ? options : callback;
    let intercept: boolean;
    try {
      intercept = shouldShortCircuit(hostname);
    } catch (e: any) {
      if (cb) { process.nextTick(() => cb(e)); return; }
      return Promise.reject(e);
    }

    if (intercept) {
      const ips = ['::1'];
      if (cb) { process.nextTick(() => cb(null, ips)); return; }
      return Promise.resolve(ips);
    }

    // Not mocked — pass through but this may reach real network.
    // If originals.resolve6 exists use it; otherwise reject.
    if (originals.resolve6) return originals.resolve6.apply(dns, [hostname, options, callback]);
    const err = Object.assign(new Error(`SimNode: dns.resolve6 for unmocked host ${hostname}`), { code: 'ENOTFOUND' });
    if (cb) { process.nextTick(() => cb(err)); return; }
    return Promise.reject(err);
  };

  return { customLookup, customResolve, customResolve4, customResolve6 };
}
