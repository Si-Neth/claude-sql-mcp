/**
 * In-memory metadata cache. Database/schema/table/column metadata changes
 * rarely, so we avoid re-querying INFORMATION_SCHEMA on every single MCP
 * tool call. Actual row DATA is never cached here — only structural
 * metadata — so cached entries carry no sensitive business data.
 */
import NodeCache from "node-cache";
import { config } from "../config.js";

const cache = new NodeCache({
  stdTTL: config.limits.cacheTtlSeconds,
  checkperiod: Math.max(30, Math.floor(config.limits.cacheTtlSeconds / 4)),
  useClones: false,
});

export async function cached<T>(key: string, loader: () => Promise<T>): Promise<T> {
  const existing = cache.get<T>(key);
  if (existing !== undefined) return existing;
  const value = await loader();
  cache.set(key, value);
  return value;
}

export function invalidate(prefix?: string): void {
  if (!prefix) {
    cache.flushAll();
    return;
  }
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) cache.del(key);
  }
}
