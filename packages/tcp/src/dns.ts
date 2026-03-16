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
 * Normalizes host lookup. If the host is in `mockedHosts`, returns 127.0.0.1.
 * If not, and `throwOnUnmocked` is true, throws ENOTFOUND.
 * Otherwise, falls back to the original function.
 */
function attemptShortCircuit<T>(hostname: string, originalFn: Function, args: any[]): T | { fallback: true } {
  if (mockedHosts.has(hostname) || hostname === 'localhost') {
    return { fallback: false, result: '127.0.0.1' } as any; 
  }
  
  if (dnsConfig.throwOnUnmocked) {
    const err = new Error(`getaddrinfo ENOTFOUND ${hostname}`);
    (err as any).code = 'ENOTFOUND';
    (err as any).syscall = 'getaddrinfo';
    (err as any).hostname = hostname;
    throw err;
  }
  
  return { fallback: true };
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

    try {
      const intercepted = attemptShortCircuit(hostname, originals.lookup, []);
      if (intercepted && typeof intercepted === 'object' && 'fallback' in intercepted && intercepted.fallback) {
        return originals.lookup.apply(dns, [hostname, options, callback]);
      }
      
      const ip = (intercepted as any).result || '127.0.0.1';
      
      if (cb) {
        process.nextTick(() => {
           if (opts && opts.all) {
             cb(null, [{ address: ip, family: 4 }]);
           } else {
             cb(null, ip, 4);
           }
        });
        return {};
      } else {
        return Promise.resolve(opts && opts.all ? [{ address: ip, family: 4 }] : { address: ip, family: 4 });
      }
    } catch (e: any) {
      if (cb) {
        process.nextTick(() => cb(e));
        return {};
      }
      return Promise.reject(e);
    }
  };

  const customResolve = function resolve(hostname: string, rrtype: any, callback?: any) {
     let cb = callback;
     let type = rrtype;
     if (typeof rrtype === 'function') {
        cb = rrtype;
        type = 'A';
     }
     
     if (type !== 'A' && type !== 'AAAA' && type !== 'ANY') {
         return originals.resolve.apply(dns, [hostname, rrtype, callback]);
     }

     try {
        const intercepted = attemptShortCircuit(hostname, originals.resolve, []);
        if (intercepted && typeof intercepted === 'object' && 'fallback' in intercepted && intercepted.fallback) {
          return originals.resolve.apply(dns, [hostname, rrtype, callback]);
        }
        const ips = [ (intercepted as any).result || '127.0.0.1' ];
        if (cb) {
           process.nextTick(() => cb(null, ips));
           return;
        }
        return Promise.resolve(ips);
     } catch(e) {
        if (cb) {
           process.nextTick(() => cb(e));
           return;
        }
        return Promise.reject(e);
     }
  };
  
  const customResolve4 = function resolve4(hostname: string, options: any, callback?: any) {
      return customResolve(hostname, 'A', typeof options === 'function' ? options : callback);
  };

  return { customLookup, customResolve, customResolve4 };
}
