// AI command flow in the real extension (Demo mode, so no model is needed):
// run → preview survives DOM mutations → apply persists across reload → undo.
// Requires `npm run build` and `npm run fixtures` (FIXTURES_URL, default :4173).

import { test, expect, chromium, type BrowserContext, type Page, type Worker } from "@playwright/test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
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

/** Send a command from an extension page, exactly as the side panel does. */
async function send(panel: Page, message: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> {
  return panel.evaluate((msg) => new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve)), message) as Promise<{ ok: boolean; error?: string }>;
}

async function jobStatus(panel: Page, tabId: number): Promise<string | undefined> {
  return panel.evaluate(async (id) => {
    const stored = await chrome.storage.session.get(`awl_job_${id}`);
    return (stored[`awl_job_${id}`] as { status?: string } | undefined)?.status;
  }, tabId);
}

const paragraphFontSize = (page: Page) => page.locator("article p").first().evaluate((element) => getComputedStyle(element).fontSize);

test("demo-mode AI plan previews, applies, survives reload and undoes", async () => {
  const { context, worker, extensionId } = await launch();
  try {
    await worker.evaluate(async () => {
      await chrome.storage.local.set({ awl_settings: { version: 9, enabled: true, ai: { demoMode: true }, profiles: [], siteRules: [] } });
    });
    const page = await context.newPage();
    await page.goto(`${FIXTURES_URL}/article-sidebars.html`, { waitUntil: "domcontentloaded" });
    const before = await paragraphFontSize(page);

    const panel = await context.newPage();
    await panel.goto(`chrome-extension://${extensionId}/sidepanel/index.html`);
    await expect(panel.locator("h1")).toHaveText("Adaptive Web Layer");
    const tabId = await worker.evaluate(async (url) => (await chrome.tabs.query({ url: `${url}/*` }))[0]?.id, FIXTURES_URL) as number;
    expect(tabId).toBeTruthy();

    expect((await send(panel, { type: "AI_RUN", tabId, request: "make the text bigger" })).ok).toBe(true);
    await expect.poll(() => jobStatus(panel, tabId)).toBe("preview");
    await expect.poll(() => paragraphFontSize(page)).toBe("20px");

    // Dynamic pages mutate constantly; the preview must not be overwritten (old bug D2).
    await page.evaluate(() => { for (let i = 0; i < 5; i++) document.body.classList.toggle(`awl-test-${i}`); });
    await page.waitForTimeout(400);
    expect(await paragraphFontSize(page)).toBe("20px");

    expect((await send(panel, { type: "AI_APPLY", tabId })).ok).toBe(true);
    await expect.poll(() => jobStatus(panel, tabId)).toBe("applied");
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect.poll(() => paragraphFontSize(page)).toBe("20px"); // saved, not just previewed (old bug D3)

    expect((await send(panel, { type: "AI_UNDO", tabId })).ok).toBe(true);
    await expect.poll(() => paragraphFontSize(page)).toBe(before);
  } finally {
    await context.close();
  }
});

test("local mode streams a plan from an OpenAI-compatible server on 127.0.0.1", async () => {
  // A stand-in for llama-server: streams a fixed plan as SSE chunks.
  const prompts: string[] = [];
  const llama = createServer((req, res) => {
    if (req.url === "/v1/models") { res.end(JSON.stringify({ data: [{ id: "fake.gguf" }] })); return; }
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      prompts.push(body);
      const plan = JSON.stringify({ interpretedRequest: "dark theme", changes: { theme: "dark", lineHeight: 1.9 }, reasons: ["asked"], confidence: 0.8 });
      res.writeHead(200, { "Content-Type": "text/event-stream", "Access-Control-Allow-Origin": "*" });
      for (const piece of plan.match(/.{1,10}/g) ?? []) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => llama.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${(llama.address() as AddressInfo).port}`;

  const { context, worker, extensionId } = await launch();
  try {
    await worker.evaluate(async (localEndpoint) => {
      await chrome.storage.local.set({ awl_settings: { version: 9, enabled: true, ai: { mode: "local", localEndpoint }, profiles: [], siteRules: [] } });
    }, endpoint);
    const page = await context.newPage();
    await page.goto(`${FIXTURES_URL}/article-sidebars.html`, { waitUntil: "domcontentloaded" });
    const panel = await context.newPage();
    await panel.goto(`chrome-extension://${extensionId}/sidepanel/index.html`);
    const tabId = await worker.evaluate(async (url) => (await chrome.tabs.query({ url: `${url}/*` }))[0]?.id, FIXTURES_URL) as number;

    await send(panel, { type: "AI_RUN", tabId, request: "dark mode and more line spacing" });
    await expect.poll(() => jobStatus(panel, tabId)).toBe("preview");
    await expect.poll(() => page.locator("article p").first().evaluate((element) => getComputedStyle(element).lineHeight)).not.toBe("normal");
    const sent = JSON.parse(prompts[0]) as { stream: boolean; response_format: { type: string } };
    expect(sent.stream).toBe(true);
    expect(sent.response_format.type).toBe("json_schema");
  } finally {
    await context.close();
    llama.close();
  }
});

const display = (page: Page, selector: string) => page.locator(selector).first().evaluate((element) => getComputedStyle(element).display);

test("clean this page: preview, confirm protected items, apply, reload, undo (demo rules)", async () => {
  const { context, worker, extensionId } = await launch();
  try {
    await worker.evaluate(async () => {
      await chrome.storage.local.set({ awl_settings: { version: 9, enabled: true, ai: { demoMode: true }, profiles: [], siteRules: [] } });
    });
    const page = await context.newPage();
    await page.goto(`${FIXTURES_URL}/clutter.html`, { waitUntil: "load" });
    const panel = await context.newPage();
    await panel.goto(`chrome-extension://${extensionId}/sidepanel/index.html`);
    const tabId = await worker.evaluate(async (url) => (await chrome.tabs.query({ url: `${url}/clutter.html` }))[0]?.id, FIXTURES_URL) as number;

    // The real side panel acts on the window's active tab: make that the fixture.
    await page.bringToFront();
    const clean = panel.getByRole("button", { name: "Clean this page" });
    await expect(clean).toBeEnabled();
    await clean.click();
    await expect.poll(() => jobStatus(panel, tabId)).toBe("preview");
    await expect.poll(() => display(page, ".promo-bar")).toBe("none");
    expect(await display(page, ".recommended-rail")).toBe("none");
    // One ad item hides every copy, including the one the page adds later.
    await page.locator("#late-ad").waitFor({ state: "attached" });
    expect(await page.locator(".ad-slot").evaluateAll((ads) => ads.map((ad) => getComputedStyle(ad).display))).toEqual(["none", "none", "none"]);
    // Protected: the cookie dialog and the newsletter form wait for an explicit OK.
    expect(await display(page, "#cookie-banner")).not.toBe("none");
    expect(await display(page, ".newsletter-overlay")).not.toBe("none");
    // Must survive: navigation, table of contents, article.
    for (const selector of ["nav", ".toc", "article"]) expect(await display(page, selector)).not.toBe("none");

    const items = await panel.evaluate(async (id) => (await chrome.storage.session.get(`awl_job_${id}`))[`awl_job_${id}`].elements as Array<{ id: string; protect?: string; enabled: boolean }>, tabId);
    const pending = items.filter((item) => item.protect && !item.enabled);
    expect(pending).toHaveLength(2);
    await expect(panel.getByText("2 items need your OK")).toBeVisible();
    for (const item of pending) expect((await send(panel, { type: "AI_SET_ELEMENT", tabId, id: item.id, enabled: true })).ok).toBe(true);
    await expect.poll(() => display(page, "#cookie-banner")).toBe("none");
    expect(await display(page, ".newsletter-overlay")).toBe("none");

    // Hovering a hidden item "peeks" it and outlines it in a Shadow DOM overlay.
    await panel.getByText("Recommended for you", { exact: false }).first().hover();
    await expect.poll(() => display(page, ".recommended-rail")).not.toBe("none");
    expect(await page.locator("[data-awl-overlay]").count()).toBe(1);
    await panel.locator("h1").hover();
    await expect.poll(() => display(page, ".recommended-rail")).toBe("none");
    expect(await page.locator("[data-awl-overlay]").count()).toBe(0);

    expect((await send(panel, { type: "AI_APPLY", tabId })).ok).toBe(true);
    await expect.poll(() => jobStatus(panel, tabId)).toBe("applied");
    expect(await page.locator("[data-awl-preview]").count()).toBe(0);
    await page.reload({ waitUntil: "load" });
    // Saved selectors, no model involved: the job record is untouched by the reload.
    for (const selector of [".promo-bar", ".recommended-rail", "#cookie-banner", ".newsletter-overlay"]) await expect.poll(() => display(page, selector)).toBe("none");
    for (const selector of ["nav", ".toc", "article"]) expect(await display(page, selector)).not.toBe("none");
    await page.locator("#late-ad").waitFor({ state: "attached" });
    expect(await display(page, "#late-ad")).toBe("none");
    const saved = await worker.evaluate(async (id) => new Promise((resolve) => chrome.tabs.sendMessage(id, { type: "CHECK_SAVED_SELECTORS" }, resolve)), tabId);
    expect(saved).toEqual({ type: "SAVED_SELECTORS", total: 5, stale: [] });

    expect((await send(panel, { type: "AI_UNDO", tabId })).ok).toBe(true);
    for (const selector of [".promo-bar", ".recommended-rail", "#cookie-banner", ".newsletter-overlay", ".ad-slot"]) await expect.poll(() => display(page, selector)).not.toBe("none");
  } finally {
    await context.close();
  }
});
