// P08 comprehension in the real extension: TL;DR card, glossary underlines,
// selection popover (Explain simply in Demo mode; Translate through a stand-in
// proxy). The page's own text must never change.
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

async function open(context: BrowserContext, worker: Worker, extensionId: string, fixture: string): Promise<{ page: Page; panel: Page; tabId: number }> {
  const page = await context.newPage();
  await page.goto(`${FIXTURES_URL}/${fixture}`, { waitUntil: "domcontentloaded" });
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel/index.html`);
  const tabId = await worker.evaluate(async (url) => (await chrome.tabs.query({ url }))[0]?.id, `${FIXTURES_URL}/${fixture}`) as number;
  await page.bringToFront();
  return { page, panel, tabId };
}

const send = (panel: Page, message: Record<string, unknown>) =>
  panel.evaluate((msg) => new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve)), message) as Promise<{ ok: boolean; error?: string }>;

type State = { summary?: { bullets: string[]; source: string }; glossary?: { terms: Array<{ term: string }>; shown: boolean }; selection?: { kind: string; text?: string; original: string; source: string }; error?: { code: string; message: string }; running?: unknown };
const state = (panel: Page, tabId: number) => panel.evaluate(async (id) => (await chrome.storage.session.get(`awl_understand_${id}`))[`awl_understand_${id}`] as State | undefined, tabId);

/** Select a paragraph and open the popover's actions with the mouse, as a reader would. */
async function openPopover(page: Page, paragraph: string): Promise<void> {
  const rect = await page.evaluate((needle) => {
    const element = Array.from(document.querySelectorAll("p")).find((item) => item.textContent?.includes(needle))!;
    element.scrollIntoView({ block: "center" });
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    const rects = range.getClientRects();
    const last = rects[rects.length - 1];
    return { left: last.left, bottom: last.bottom };
  }, paragraph);
  await page.waitForSelector("[data-awl-overlay='selection']", { state: "attached" });
  // The "✨ Understand" button sits just below the end of the selection.
  await page.mouse.click(rect.left + 40, rect.bottom + 6 + 8 + 10);
}

test("TL;DR card, glossary underlines and Explain simply (Demo mode) leave the page text intact", async () => {
  const { context, worker, extensionId } = await launch();
  try {
    await worker.evaluate(async () => { await chrome.storage.local.set({ awl_settings: { version: 9, enabled: true, ai: { demoMode: true }, profiles: [], siteRules: [] } }); });
    const { page, panel, tabId } = await open(context, worker, extensionId, "long-article.html");
    const before = await page.locator("main").innerText();

    expect((await send(panel, { type: "UNDERSTAND_RUN", tabId, kind: "summarize" })).ok).toBe(true);
    await expect.poll(async () => (await state(panel, tabId))?.summary?.bullets.length ?? 0).toBeGreaterThanOrEqual(3);
    // The card is inside <main>, above the article, in a closed shadow root.
    await expect(page.locator("main > [data-awl-overlay='summary']")).toHaveCount(1);
    await expect(panel.getByText("Demo mode, no AI").first()).toBeVisible();

    await send(panel, { type: "UNDERSTAND_RUN", tabId, kind: "glossary" });
    await expect.poll(async () => (await state(panel, tabId))?.glossary?.shown).toBe(true);
    await expect.poll(() => page.evaluate(() => CSS.highlights.get("awl-glossary")?.size ?? 0)).toBeGreaterThan(0);
    // The panel learns where each term is, and "Show" scrolls to it.
    const glossary = (await state(panel, tabId))!.glossary!.terms as Array<{ term: string; count?: number }>;
    const found = glossary.find((item) => (item.count ?? 0) > 0)!;
    expect(found).toBeTruthy();
    expect(await panel.evaluate(([id, term]) => new Promise((resolve) => chrome.tabs.sendMessage(id as number, { type: "GLOSSARY_REVEAL", term }, resolve)), [tabId, found.term])).toMatchObject({ ok: true });
    await send(panel, { type: "UNDERSTAND_HIDE", tabId, what: "glossary" });
    await expect.poll(() => page.evaluate(() => CSS.highlights.has("awl-glossary"))).toBe(false);

    await openPopover(page, "The ripple is called monetary policy transmission");
    await page.keyboard.press("Enter"); // "Explain simply" has focus
    await expect.poll(async () => (await state(panel, tabId))?.selection?.kind).toBe("simplify");
    expect((await state(panel, tabId))?.selection?.original).toContain("The ripple is called monetary policy transmission");

    await send(panel, { type: "UNDERSTAND_HIDE", tabId, what: "summary" });
    await expect(page.locator("[data-awl-overlay='summary']")).toHaveCount(0);
    await page.keyboard.press("Escape");
    expect(await page.locator("main").innerText()).toBe(before);
  } finally {
    await context.close();
  }
});

test("Translate sends masked text to the proxy and shows Hindi with code and links restored", async () => {
  // A stand-in for the local proxy's Sarvam route: "translates" by prefixing Hindi, keeping placeholders.
  const received: string[] = [];
  const proxy = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/health") { res.end(JSON.stringify({ ok: true, backends: { gemini: true, anthropic: false, sarvam: true } })); return; }
      received.push(body);
      const { text } = JSON.parse(body) as { text: string };
      res.end(JSON.stringify({ text: `हिंदी अनुवाद: ${text}`, modelId: "sarvam-translate:v1" }));
    });
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;

  const { context, worker, extensionId } = await launch();
  try {
    await worker.evaluate(async (cloudProxyUrl) => {
      await chrome.storage.local.set({ awl_settings: { version: 9, enabled: true, ai: { mode: "cloud", cloudProxyUrl, cloudProxyToken: "test-token" }, privacy: { cloudSiteConsents: { localhost: "allow" } }, profiles: [], siteRules: [] } });
    }, proxyUrl);
    const { page, panel, tabId } = await open(context, worker, extensionId, "bilingual.html");
    const before = await page.locator("main").innerText();

    await openPopover(page, "The widget reads forecasts from");
    await page.keyboard.press("Tab"); // Explain simply → Translate (no Define for a long selection)
    await page.keyboard.press("Enter");
    await expect.poll(async () => (await state(panel, tabId))?.selection?.text ?? "").toContain("हिंदी अनुवाद");

    const result = (await state(panel, tabId))!.selection!;
    expect(result).toMatchObject({ kind: "translate", source: "sarvam" });
    expect(result.text).toContain("https://api.monsoon.example.org/v2/forecast");
    expect(result.text).toContain("user_settings.json");
    expect(result.text).toContain("API_KEY");
    // What left the browser had placeholders instead of links, file names and identifiers.
    expect(received).toHaveLength(1);
    expect(received[0]).not.toMatch(/monsoon\.example|user_settings|API_KEY/);
    expect(received[0]).toMatch(/\[\[\d+\]\]/);
    expect(await page.locator("main").innerText()).toBe(before);
  } finally {
    await context.close();
    proxy.close();
  }
});

test("Local mode never sends a translation to the proxy; it offers the local model instead", async () => {
  const received: string[] = [];
  const proxy = createServer((req, res) => { received.push(req.url ?? ""); res.end("{}"); });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
  const { context, worker, extensionId } = await launch();
  try {
    await worker.evaluate(async (cloudProxyUrl) => {
      await chrome.storage.local.set({ awl_settings: { version: 9, enabled: true, ai: { mode: "local", cloudProxyUrl, cloudProxyToken: "t" }, privacy: { cloudSiteConsents: { localhost: "allow" } }, profiles: [], siteRules: [] } });
    }, proxyUrl);
    const { page, panel, tabId } = await open(context, worker, extensionId, "bilingual.html");
    await openPopover(page, "If the forecast does not update");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Enter");
    await expect.poll(async () => (await state(panel, tabId))?.error?.code).toBe("unsupported");
    await expect(panel.getByRole("button", { name: "Translate with the local model (lower quality)" })).toBeVisible();
    expect(received.filter((url) => url !== "/health")).toEqual([]);
  } finally {
    await context.close();
    proxy.close();
  }
});
