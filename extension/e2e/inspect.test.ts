// P09 inspector in the real extension, with AI off (local mode, no server):
// every planted problem on a11y-issues.html is found and none on a11y-clean.html;
// the side panel highlights a finding, applies the high-confidence fixes as one
// job (score goes up) and Undo restores the page.
// Requires `npm run build` and `npm run fixtures` (FIXTURES_URL, default :4173).

import { test, expect, chromium, type BrowserContext, type Page, type Worker } from "@playwright/test";
import path from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const EXTENSION_PATH = path.resolve(dirname(fileURLToPath(import.meta.url)), "../dist");
const FIXTURES_URL = process.env.FIXTURES_URL ?? "http://localhost:4173";

async function launch(): Promise<{ context: BrowserContext; worker: Worker; extensionId: string }> {
  const context = await chromium.launchPersistentContext("", {
    executablePath: process.env.CHROME_PATH,
    headless: false,
    args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`, "--no-sandbox", "--headless=new"],
  });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker", { timeout: 10_000 });
  return { context, worker, extensionId: new URL(worker.url()).host };
}

async function open(context: BrowserContext, worker: Worker, extensionId: string, fixture: string): Promise<{ page: Page; panel: Page; tabId: number }> {
  const page = await context.newPage();
  await page.goto(`${FIXTURES_URL}/${fixture}`, { waitUntil: "load" });
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel/index.html`);
  const tabId = await worker.evaluate(async (url) => (await chrome.tabs.query({ url }))[0]?.id, `${FIXTURES_URL}/${fixture}`) as number;
  await page.bringToFront();
  return { page, panel, tabId };
}

const send = (panel: Page, message: Record<string, unknown>) =>
  panel.evaluate((msg) => new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve)), message) as Promise<{ ok: boolean; error?: string }>;

interface State { report?: { findings: Array<{ id: string; type: string; confidence: string; suggestedFix?: unknown }>; score: { value: number } }; previousScore?: number }
const state = (panel: Page, tabId: number) => panel.evaluate(async (id) => (await chrome.storage.session.get(`awl_inspect_${id}`))[`awl_inspect_${id}`] as State | undefined, tabId);

const AI_OFF = { version: 9, enabled: true, ai: { mode: "local", localEndpoint: "http://127.0.0.1:9" }, profiles: [], siteRules: [] };

test("every planted problem is found on a11y-issues.html and nothing on a11y-clean.html", async () => {
  const { context, worker, extensionId } = await launch();
  try {
    await worker.evaluate(async (settings) => { await chrome.storage.local.set({ awl_settings: settings }); }, AI_OFF);
    const issues = await open(context, worker, extensionId, "a11y-issues.html");
    expect((await send(issues.panel, { type: "INSPECT_RUN", tabId: issues.tabId })).ok).toBe(true);
    const found = (await state(issues.panel, issues.tabId))!.report!;
    const types = new Set(found.findings.map((finding) => finding.type));
    for (const type of ["small-text", "low-contrast", "tight-line-height", "long-lines", "huge-block", "multiple-h1", "skipped-heading", "empty-heading",
      "horizontal-overflow", "clipped-content", "overlap", "sticky-cover", "link-distinction", "focus-indicator"]) {
      expect(types, type).toContain(type);
    }
    // The gradient hero is reported, but only as uncertain.
    expect(found.findings.filter((finding) => finding.type === "low-contrast").map((finding) => finding.confidence)).toContain("low");
    expect(found.score.value).toBeLessThan(40);
    // Stable on an unchanged page.
    await send(issues.panel, { type: "INSPECT_RUN", tabId: issues.tabId });
    const again = (await state(issues.panel, issues.tabId))!.report!;
    expect(again.score.value).toBe(found.score.value);
    expect(again.findings.map((finding) => finding.id)).toEqual(found.findings.map((finding) => finding.id));

    const clean = await open(context, worker, extensionId, "a11y-clean.html");
    await send(clean.panel, { type: "INSPECT_RUN", tabId: clean.tabId });
    const cleanReport = (await state(clean.panel, clean.tabId))!.report!;
    expect(cleanReport.findings.map((finding) => finding.type)).toEqual([]);
    expect(cleanReport.score.value).toBe(100);
  } finally {
    await context.close();
  }
});

test("side panel: highlight a finding, apply high-confidence fixes, undo", async () => {
  const { context, worker, extensionId } = await launch();
  try {
    await worker.evaluate(async (settings) => { await chrome.storage.local.set({ awl_settings: settings }); }, AI_OFF);
    const { page, panel, tabId } = await open(context, worker, extensionId, "a11y-issues.html");
    const promo = () => page.locator(".promo-bar").evaluate((element) => getComputedStyle(element).display);
    const finePrint = () => page.locator(".fine-print").evaluate((element) => getComputedStyle(element).fontSize);

    await expect(panel.getByText("does not make a site WCAG compliant")).toBeVisible();
    await panel.getByRole("button", { name: "Inspect this page" }).click();
    await expect(panel.getByLabel(/Readability score \d+ out of 100/)).toBeVisible();
    const before = (await state(panel, tabId))!.report!.score.value;

    // "Show on page" outlines the element in a Shadow DOM overlay.
    await panel.locator(".finding").filter({ hasText: "Small text" }).getByRole("button", { name: "Show on page" }).click();
    await expect(page.locator("[data-awl-overlay='outline']")).toHaveCount(1);

    await panel.getByRole("button", { name: /Apply all high-confidence fixes/ }).click();
    await expect.poll(async () => (await state(panel, tabId))?.previousScore).toBe(before);
    const after = (await state(panel, tabId))!.report!.score.value;
    expect(after).toBeGreaterThan(before);
    await expect(panel.getByText(`was ${before} before the last change`)).toBeVisible();
    expect(await promo()).toBe("none");
    expect(await finePrint()).toBe("18px");
    // The fix is the shared AI job, so it survives a reload like any applied plan.
    expect(await panel.evaluate(async (id) => ((await chrome.storage.session.get(`awl_job_${id}`))[`awl_job_${id}`] as { status: string; source: string }), tabId)).toMatchObject({ status: "applied", source: "inspector" });

    await panel.getByRole("button", { name: "Undo fixes" }).click();
    await expect.poll(async () => (await state(panel, tabId))?.report?.score.value).toBe(before);
    expect(await promo()).toBe("flex");
    expect(await finePrint()).toBe("11px");
  } finally {
    await context.close();
  }
});
