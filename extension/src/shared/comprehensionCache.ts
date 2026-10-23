// ─── Comprehension result cache ──────────────────────────────────────────────
// Key: job kind + hash(URL without fragment, variant, content). Entries expire
// after CACHE_TTL_MS and only the newest MAX_ENTRIES are kept. Settings →
// Privacy → "Clear all data" wipes chrome.storage.local, caches included.

import type { z } from "zod";

export const CACHE_PREFIX = "awl_cache_";
export const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 40;

interface Entry { at: number; value: unknown }

export async function hashText(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest).slice(0, 12), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Same page content (and variant, e.g. target language) → same key; any edit to the text → a new key. */
export async function cacheKey(kind: string, url: string, content: string, variant = ""): Promise<string> {
  const page = url.split("#")[0];
  return `${CACHE_PREFIX}${kind}:${await hashText(`${page}\u0000${variant}\u0000${content}`)}`;
}

export async function readCache<S extends z.ZodTypeAny>(key: string, schema: S, now = Date.now()): Promise<z.output<S> | null> {
  try {
    const entry = (await chrome.storage.local.get(key))[key] as Entry | undefined;
    if (!entry) return null;
    if (now - entry.at > CACHE_TTL_MS) { await chrome.storage.local.remove(key); return null; }
    const parsed = schema.safeParse(entry.value);
    return parsed.success ? parsed.data as z.output<S> : null;
  } catch {
    return null;
  }
}

export async function writeCache(key: string, value: unknown, now = Date.now()): Promise<void> {
  try {
    await chrome.storage.local.set({ [key]: { at: now, value } satisfies Entry });
    const all = await chrome.storage.local.get(null);
    const entries = Object.entries(all).filter(([name]) => name.startsWith(CACHE_PREFIX)) as Array<[string, Entry]>;
    const stale = entries.filter(([, entry]) => now - entry.at > CACHE_TTL_MS).map(([name]) => name);
    const fresh = entries.filter(([name]) => !stale.includes(name)).sort((a, b) => b[1].at - a[1].at);
    const remove = [...stale, ...fresh.slice(MAX_ENTRIES).map(([name]) => name)];
    if (remove.length) await chrome.storage.local.remove(remove);
  } catch { /* a full or unavailable store only costs a cache miss */ }
}
