// End-to-end job lifecycle against an in-memory fake of the chrome APIs:
// run → preview (overlay only) → apply (saved) → undo (restored).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyJob, discardJob, runAiJob, saveProfile, undoJob, useFallback } from "../background/aiJobs";
import { cancelJob } from "../background/jobs";
import { readJob } from "../shared/aiJob";
import { defaultSettings, resolveTypography, type Settings } from "../shared/settings";
import { loadSettings, saveSettings } from "../shared/storage";

const TAB = 7;
const snapshot = {
  url: "https://example.com/a", title: "A", contentRegion: "main", headings: [], landmarks: [],
  textBlocks: [], imageCnt: 0, tableCnt: 0, codeBlockCnt: 1, tokenEstimate: 10,
};

function memoryArea() {
  const data: Record<string, unknown> = {};
  return {
    data,
    get: vi.fn(async (key?: string | null) => (key ? { [key]: data[key] } : { ...data })),
    set: vi.fn(async (values: Record<string, unknown>) => { Object.assign(data, structuredClone(values)); }),
    remove: vi.fn(async (key: string) => { delete data[key]; }),
  };
}

let previews: unknown[];

function installChrome(): void {
  previews = [];
  vi.stubGlobal("chrome", {
    runtime: { lastError: undefined, getPlatformInfo: vi.fn(async () => ({})) },
    storage: { local: memoryArea(), session: memoryArea(), onChanged: { addListener: vi.fn() } },
    tabs: {
      get: vi.fn(async () => ({ id: TAB, url: "https://example.com/a" })),
      sendMessage: vi.fn((_tabId: number, message: { type: string; changes?: unknown }, reply: (response: unknown) => void) => {
        if (message.type === "GET_DOM_SNAPSHOT") reply({ type: "DOM_SNAPSHOT", payload: snapshot });
        else { if (message.type === "SET_PREVIEW") previews.push(message.changes); reply({ type: "ACK", ok: true }); }
      }),
    },
  });
}

async function useSettings(patch: (settings: Settings) => Settings): Promise<void> {
  await saveSettings(patch(defaultSettings()));
}

const fontSizeOnSite = async () => resolveTypography(await loadSettings(), "example.com").fontSize;

beforeEach(installChrome);
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("AI job lifecycle", () => {
  it("previews without saving, applies on request, and undo restores", async () => {
    await useSettings((settings) => ({ ...settings, ai: { ...settings.ai, demoMode: true } }));
    await runAiJob(TAB, "make the text bigger");

    const previewed = await readJob(TAB);
    expect(previewed).toMatchObject({ status: "preview", source: "demo", changes: { fontSize: 20 } });
    expect(previews.at(-1)).toEqual({ fontSize: 20 });
    expect(await fontSizeOnSite()).toBe(16); // preview is not saved

    expect(await applyJob(TAB)).toBeNull();
    expect(await fontSizeOnSite()).toBe(20);
    expect(previews.at(-1)).toBeNull(); // overlay cleared once the rule holds the change
    expect((await readJob(TAB))?.status).toBe("applied");

    expect(await undoJob(TAB)).toBeNull();
    expect(await fontSizeOnSite()).toBe(16);
    expect((await loadSettings()).siteRules).toEqual([]);
  });

  it("discard clears the preview and the job", async () => {
    await useSettings((settings) => ({ ...settings, ai: { ...settings.ai, demoMode: true } }));
    await runAiJob(TAB, "dark mode");
    await discardJob(TAB);
    expect(previews.at(-1)).toBeNull();
    expect(await readJob(TAB)).toBeNull();
  });

  it("reports an unreachable local server with a no-AI suggestion", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("connection refused"); }));
    await runAiJob(TAB, "bigger text please");
    const failed = await readJob(TAB);
    expect(failed).toMatchObject({ status: "error", error: { code: "server-not-running" }, fallback: { changes: { fontSize: 20 } } });

    expect(await useFallback(TAB)).toBeNull();
    expect(await readJob(TAB)).toMatchObject({ status: "preview", source: "rules", changes: { fontSize: 20 } });
  });

  it("asks for consent in hybrid mode instead of silently failing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("connection refused"); }));
    await useSettings((settings) => ({ ...settings, ai: { ...settings.ai, mode: "hybrid" } }));
    await runAiJob(TAB, "make it easier to read");
    expect((await readJob(TAB))?.error?.code).toBe("consent-required");
  });

  it("refuses when the extension is off for the site", async () => {
    await useSettings((settings) => ({ ...settings, siteRules: [{ hostname: "example.com", enabled: false, includeSubdomains: false, profileId: null, disabledOperations: [], typography: {}, appearance: {} }] }));
    await runAiJob(TAB, "bigger text");
    expect((await readJob(TAB))?.error?.code).toBe("unsupported");
  });

  it("can be cancelled while waiting for the model", async () => {
    vi.stubGlobal("fetch", vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    })));
    const running = runAiJob(TAB, "bigger text");
    await vi.waitFor(async () => expect((await readJob(TAB))?.stage).toContain("Asking"));
    expect(cancelJob(TAB)).toBe(true);
    await running;
    expect((await readJob(TAB))?.status).toBe("cancelled");
  });

  it("saves what the page shows (including a preview) as a profile", async () => {
    await useSettings((settings) => ({ ...settings, ai: { ...settings.ai, demoMode: true } }));
    await runAiJob(TAB, "bigger text");
    expect(await saveProfile(TAB, "Big text")).toBeNull();
    const profile = (await loadSettings()).profiles.find((item) => item.name === "Big text");
    expect(profile?.typography.fontSize).toBe(20);
    expect(await saveProfile(TAB, "big TEXT")).toContain("already exists");
  });

  it("only works on regular web pages", async () => {
    (chrome.tabs.get as ReturnType<typeof vi.fn>).mockResolvedValue({ id: TAB, url: "chrome://settings" });
    await runAiJob(TAB, "bigger text");
    expect((await readJob(TAB))?.error?.code).toBe("unsupported");
  });
});
