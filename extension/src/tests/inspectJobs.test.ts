// Inspector jobs against an in-memory fake of the chrome APIs: inspect → score
// → apply fixes (one AI job, saved to the site rule) → re-check → undo.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyInspectFixes, explainInspect, runInspect, undoInspectFixes } from "../background/inspect";
import { readJob } from "../shared/aiJob";
import { readInspect, type Finding } from "../shared/inspector";
import { defaultSettings, resolveAppearance, resolveFocus, resolveTypography } from "../shared/settings";
import { loadSettings, saveSettings } from "../shared/storage";

const TAB = 3;
const finding = (id: string, type: Finding["type"], extra: Partial<Finding> = {}): Finding => ({ id, type, severity: "high", confidence: "high", title: type, detail: "measured", evidence: { n: 1 }, ...extra });

/** What the content script reports; the second inspection (after a fix) is cleaner. */
let reports: Finding[][];
const sent: string[] = [];

function memoryArea() {
  const data: Record<string, unknown> = {};
  return {
    get: vi.fn(async (key?: string | null) => (key ? { [key]: data[key] } : { ...data })),
    set: vi.fn(async (values: Record<string, unknown>) => { Object.assign(data, structuredClone(values)); }),
    remove: vi.fn(async (key: string) => { delete data[key]; }),
  };
}

beforeEach(async () => {
  sent.length = 0;
  reports = [
    [
      finding("small-text-1", "small-text", { suggestedFix: { changes: { fontSize: 18 }, hide: [], description: "Text 18px" } }),
      finding("low-contrast-1", "low-contrast", { suggestedFix: { changes: { fixContrast: true }, hide: [], description: "Fix contrast" } }),
      finding("sticky-cover-1", "sticky-cover", { label: "div “Pay online”", suggestedFix: { changes: {}, hide: ["s16"], description: "Hide this bar" } }),
      finding("no-h1-1", "no-h1", { severity: "medium", advice: "Only the site can change its headings." }),
    ],
    [finding("no-h1-1", "no-h1", { severity: "medium" })],
  ];
  let inspection = 0;
  vi.stubGlobal("chrome", {
    runtime: { lastError: undefined, getPlatformInfo: vi.fn(async () => ({})) },
    storage: { local: memoryArea(), session: memoryArea(), onChanged: { addListener: vi.fn() } },
    tabs: {
      get: vi.fn(async () => ({ id: TAB, url: "https://example.com/notice" })),
      sendMessage: vi.fn((_tab: number, message: { type: string }, reply: (response: unknown) => void) => {
        sent.push(message.type);
        if (message.type === "INSPECT_PAGE") {
          const findings = reports[Math.min(inspection++, reports.length - 1)];
          reply({ type: "INSPECT_RESULT", report: { findings, scanned: 120, capped: false, durationMs: 9 } });
        } else if (message.type === "RESOLVE_SELECTORS") reply({ type: "SELECTORS", selectors: { s16: "div.promo-bar" } });
        else reply({ type: "ACK", ok: true });
      }),
    },
  });
  await saveSettings(defaultSettings());
});

describe("inspector jobs", () => {
  it("stores findings with a score computed in the background", async () => {
    await runInspect(TAB);
    const state = await readInspect(TAB);
    expect(state?.running).toBeUndefined();
    expect(state?.report?.findings).toHaveLength(4);
    expect(state?.report?.score.value).toBeLessThan(100);
    expect(state?.report?.score.contributors.length).toBeGreaterThan(0);
  });

  it("applies fixes as one undoable AI job and shows the score before and after", async () => {
    await runInspect(TAB);
    const before = (await readInspect(TAB))!.report!.score.value;
    expect(await applyInspectFixes(TAB, ["small-text-1", "low-contrast-1", "sticky-cover-1", "no-h1-1"])).toBeNull();

    const job = await readJob(TAB);
    expect(job).toMatchObject({ status: "applied", source: "inspector", changes: { fontSize: 18, fixContrast: true } });
    expect(job?.elements).toEqual([{ id: "s16", action: "hide", label: "div “Pay online”", enabled: true }]);
    const settings = await loadSettings();
    expect(resolveTypography(settings, "example.com").fontSize).toBe(18);
    expect(resolveAppearance(settings, "example.com").fixContrast).toBe(true);
    expect(resolveFocus(settings, "example.com").hiddenSelectors).toEqual(["div.promo-bar"]);

    const after = await readInspect(TAB);
    expect(after?.previousScore).toBe(before);
    expect(after?.report?.score.value).toBeGreaterThan(before);
    expect(sent.filter((type) => type === "INSPECT_PAGE")).toHaveLength(2);

    // Undo restores the site exactly as it was, then checks again.
    expect(await undoInspectFixes(TAB)).toBeNull();
    const restored = await loadSettings();
    expect(resolveTypography(restored, "example.com").fontSize).toBe(16);
    expect(resolveAppearance(restored, "example.com").fixContrast).toBe(false);
    expect(resolveFocus(restored, "example.com").hiddenSelectors).toEqual([]);
    expect((await readJob(TAB))?.status).toBe("cancelled");
  });

  it("refuses findings without a fix, and an undo that is not an inspector fix", async () => {
    await runInspect(TAB);
    expect(await applyInspectFixes(TAB, ["no-h1-1"])).toMatch(/has an automatic fix/);
    expect(await undoInspectFixes(TAB)).toMatch(/no applied inspector fix/);
  });

  it("does not apply fixes on a site where the extension is turned off", async () => {
    await saveSettings({ ...defaultSettings(), siteRules: [{ hostname: "example.com", enabled: false, includeSubdomains: false, profileId: null, disabledOperations: [], typography: {}, appearance: {} }] });
    await runInspect(TAB);
    expect(await applyInspectFixes(TAB, ["small-text-1"])).toMatch(/turned off/);
    expect(await readJob(TAB)).toBeNull();
  });

  it("explains in Demo mode without any model, labelled as such", async () => {
    await saveSettings({ ...defaultSettings(), ai: { ...defaultSettings().ai, demoMode: true } });
    await runInspect(TAB);
    expect(await explainInspect(TAB)).toBeNull();
    const interpretation = (await readInspect(TAB))?.interpretation;
    expect(interpretation?.source).toBe("demo");
    expect(interpretation?.summary).toMatch(/Demo mode/);
    expect(interpretation?.priorities.map((item) => item.id)).toContain("small-text-1");
  });
});
