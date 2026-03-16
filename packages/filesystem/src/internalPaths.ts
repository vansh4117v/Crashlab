import path from 'node:path';

/**
 * Normalizes an arbitrary path string to a canonical absolute internal representation
 * using `/` as the separator, regardless of the underlying OS.
 */
export function normalizePath(p: string): string {
  // 1. Resolve to absolute path on the current OS
  const resolved = path.resolve(p);
  
  // 2. Replace all Windows backslashes with forward slashes
  return resolved.replace(/\\/g, '/');
}
