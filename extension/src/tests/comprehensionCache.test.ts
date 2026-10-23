import { beforeEach, describe, expect, it } from "vitest";
import { CACHE_PREFIX, CACHE_TTL_MS, cacheKey, readCache, writeCache } from "../shared/comprehensionCache";
import { SummaryResultSchema } from "../shared/comprehension";

let store: Record<string, unknown>;
beforeEach(() => {
  store = {};
  const local = {
    get: async (key: string | null) => (key === null ? { ...store } : key in store ? { [key]: store[key] } : {}),
    set: async (items: Record<string, unknown>) => { Object.assign(store, items); },
    remove: async (keys: string | string[]) => { for (const key of [keys].flat()) delete store[key]; },
  };
  (globalThis as unknown as { chrome: unknown }).chrome = { storage: { local } };
});

const summary = { bullets: ["a.", "b.", "c."], readingMinutes: 3, keyTerms: [], coverage: 1, source: "local", cached: false, notes: [] };

describe("comprehension cache", () => {
  it("hits for the same page content and misses when the text, URL, kind or variant changes", async () => {
    const key = await cacheKey("summarize", "https://example.org/a#section", "Article text.");
    await writeCache(key, summary, 1000);
    expect(await readCache(key, SummaryResultSchema, 2000)).toMatchObject({ bullets: ["a.", "b.", "c."] });
    expect(await cacheKey("summarize", "https://example.org/a", "Article text.")).toBe(key); // fragment ignored
    const others = await Promise.all([
      cacheKey("summarize", "https://example.org/a", "Article text, edited."),
      cacheKey("summarize", "https://example.org/b", "Article text."),
      cacheKey("glossary", "https://example.org/a", "Article text."),
      cacheKey("summarize", "https://example.org/a", "Article text.", "hi-IN"),
    ]);
    expect(new Set([key, ...others]).size).toBe(5);
  });

  it("expires entries after the TTL and removes them", async () => {
    const key = await cacheKey("summarize", "https://example.org/a", "Text.");
    await writeCache(key, summary, 0);
    expect(await readCache(key, SummaryResultSchema, CACHE_TTL_MS + 1)).toBeNull();
    expect(key in store).toBe(false);
  });

  it("ignores entries that no longer match the schema", async () => {
    const key = await cacheKey("summarize", "https://example.org/a", "Text.");
    await writeCache(key, { bullets: "not a list" }, 0);
    expect(await readCache(key, SummaryResultSchema, 1)).toBeNull();
  });

  it("keeps only the newest 40 entries", async () => {
    for (let index = 0; index < 45; index++) await writeCache(`${CACHE_PREFIX}test:${index}`, summary, 1000 + index);
    const kept = Object.keys(store).filter((name) => name.startsWith(CACHE_PREFIX));
    expect(kept).toHaveLength(40);
    expect(kept).not.toContain(`${CACHE_PREFIX}test:0`);
    expect(kept).toContain(`${CACHE_PREFIX}test:44`);
  });
});
