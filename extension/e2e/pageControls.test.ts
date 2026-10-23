// Reset page, motion settings and Smart theme in the real extension.
// Requires `npm run build` and `npm run fixtures` (FIXTURES_URL, default :4173).

import { test, expect, chromium, type BrowserContext, type Locator, type Page, type Worker } from "@playwright/test";
import path from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const EXTENSION_PATH = path.resolve(dirname(fileURLToPath(import.meta.url)), "../dist");
const FIXTURES_URL = process.env.FIXTURES_URL ?? "http://localhost:4173";

async function launch(): Promise<{ context: BrowserContext; worker: Worker }> {
  const context = await chromium.launchPersistentContext("", {
    executablePath: process.env.CHROME_PATH,
    headless: false,
    args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`, "--no-sandbox", "--headless=new"],
  });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker", { timeout: 10_000 });
  return { context, worker };
}

/** Save settings with one rule for the fixture host, as the popup panels do. */
async function saveSiteRule(worker: Worker, rule: Record<string, unknown>): Promise<void> {
  await worker.evaluate(async (siteRule) => {
    await chrome.storage.local.set({ awl_settings: { version: 9, enabled: true, profiles: [], siteRules: [{ hostname: "localhost", ...siteRule }] } });
  }, rule);
}

async function siteRule(worker: Worker): Promise<Record<string, unknown> | undefined> {
  return worker.evaluate(async () => {
    const { awl_settings: settings } = await chrome.storage.local.get("awl_settings");
    return (settings as { siteRules: Array<Record<string, unknown>> }).siteRules.find((rule) => rule.hostname === "localhost");
  });
}

const fontSize = (page: Page) => page.locator("article p").first().evaluate((element) => getComputedStyle(element).fontSize);
const isPaused = (page: Page, id: string) => page.locator(id).evaluate((video) => (video as HTMLVideoElement).paused);

/** Contrast of an element's text against the nearest painted background colour. */
function contrastOf(locator: Locator): Promise<number> {
  return locator.evaluate((element) => {
    const channels = (value: string) => (value.match(/[\d.]+/g) ?? []).map(Number);
    const luminance = ([r, g, b]: number[]) => {
      const linear = (channel: number) => { const c = channel / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
      return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
    };
    let background = [18, 18, 18];
    for (let node: Element | null = element; node; node = node.parentElement) {
      const color = channels(getComputedStyle(node).backgroundColor);
      if (color.length === 3 || (color.length === 4 && color[3] > 0)) { background = color; break; }
    }
    const [a, b] = [luminance(channels(getComputedStyle(element).color)), luminance(background)];
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  });
}

test("Reset page removes this site's changes but keeps the extension on", async () => {
  const { context, worker } = await launch();
  try {
    const page = await context.newPage();
    await saveSiteRule(worker, {});
    await page.goto(`${FIXTURES_URL}/article-sidebars.html`, { waitUntil: "domcontentloaded" });
    const natural = await fontSize(page);
    await saveSiteRule(worker, { typography: { fontSize: 24 }, motion: { reduceMotion: true } });
    await expect.poll(() => fontSize(page)).toBe("24px");

    await worker.evaluate(async (url) => {
      const [tab] = await chrome.tabs.query({ url: `${url}/*` });
      await chrome.tabs.sendMessage(tab.id!, { type: "RESET_PAGE" });
    }, FIXTURES_URL);
    await expect.poll(() => fontSize(page)).toBe(natural);
    expect(await siteRule(worker)).toMatchObject({ enabled: true });

    // The next change (as from the popup) applies straight away.
    await worker.evaluate(async () => {
      const { awl_settings: settings } = await chrome.storage.local.get("awl_settings");
      const typed = settings as { siteRules: Array<{ hostname: string; typography: Record<string, unknown> }> };
      typed.siteRules = typed.siteRules.map((rule) => rule.hostname === "localhost" ? { ...rule, typography: { ...rule.typography, fontSize: 20 } } : rule);
      await chrome.storage.local.set({ awl_settings: typed });
    });
    await expect.poll(() => fontSize(page)).toBe("20px");
  } finally {
    await context.close();
  }
});

test("Pause autoplay stops attribute and script-started playback, but not the user's", async () => {
  const { context, worker } = await launch();
  try {
    const page = await context.newPage();
    // Without the setting the fixture's videos really play (proves the check below means something).
    await saveSiteRule(worker, {});
    await page.goto(`${FIXTURES_URL}/motion-autoplay.html`, { waitUntil: "domcontentloaded" });
    // Chrome only autoplays muted video while it is on screen.
    await page.locator("#attr-video").scrollIntoViewIfNeeded();
    await expect.poll(() => isPaused(page, "#script-video"), { timeout: 5000 }).toBe(false);
    await expect.poll(() => isPaused(page, "#attr-video")).toBe(false);

    await saveSiteRule(worker, { motion: { pauseAutoplay: true } });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator("#attr-video").scrollIntoViewIfNeeded();
    await page.waitForTimeout(2000); // the fixture calls play() at 1 s
    expect(await isPaused(page, "#attr-video")).toBe(true);
    expect(await isPaused(page, "#script-video")).toBe(true);

    await page.click("#play-script-video");
    await expect.poll(() => isPaused(page, "#script-video")).toBe(false);
    // Changing another setting re-applies motion operations; the user's video keeps playing.
    await saveSiteRule(worker, { motion: { pauseAutoplay: true, reduceMotion: true } });
    await page.waitForTimeout(700);
    expect(await isPaused(page, "#script-video")).toBe(false);
    expect(await isPaused(page, "#attr-video")).toBe(true);
  } finally {
    await context.close();
  }
});

test("Reduce motion settles CSS and script animations, and undoes cleanly", async () => {
  const { context, worker } = await launch();
  try {
    const page = await context.newPage();
    await saveSiteRule(worker, { motion: { reduceMotion: true } });
    await page.goto(`${FIXTURES_URL}/motion-autoplay.html`, { waitUntil: "domcontentloaded" });
    const spinner = () => page.locator("#script-spinner").evaluate((element) => element.getAnimations()[0]?.playState);
    await expect.poll(spinner).toBe("paused");
    expect(await page.locator(".pulse").evaluate((element) => getComputedStyle(element).animationIterationCount)).toBe("1");

    await saveSiteRule(worker, { motion: { reduceMotion: false } });
    await expect.poll(spinner).toBe("running");
    expect(await page.locator(".pulse").evaluate((element) => getComputedStyle(element).animationIterationCount)).toBe("infinite");
  } finally {
    await context.close();
  }
});

test("Smart dark keeps header text readable, including headers added or restyled later", async () => {
  const { context, worker } = await launch();
  try {
    const page = await context.newPage();
    await saveSiteRule(worker, { appearance: { theme: "dark", engine: "smart" } });
    await page.goto(`${FIXTURES_URL}/smart-header.html`, { waitUntil: "domcontentloaded" });
    await expect.poll(() => page.locator("body").evaluate((element) => getComputedStyle(element).backgroundColor)).toBe("rgb(32, 33, 36)");

    for (const selector of [".brand strong", ".brand a", "main h1", "main p"]) {
      expect(await contrastOf(page.locator(selector).first()), selector).toBeGreaterThanOrEqual(4.5);
    }
    // Text over the gradient keeps the colour the site chose for that gradient.
    expect(await page.locator(".hero h2").evaluate((element) => getComputedStyle(element).color)).toBe("rgb(15, 23, 42)");

    await page.locator("#late-banner span").waitFor();
    await expect.poll(() => contrastOf(page.locator("#late-banner span"))).toBeGreaterThanOrEqual(4.5);
    await expect.poll(() => page.locator("#late-banner").evaluate((element) => getComputedStyle(element).backgroundColor)).not.toBe("rgb(248, 250, 252)");

    await page.mouse.wheel(0, 400);
    await expect.poll(() => page.locator("#sticky-bar").evaluate((element) => element.classList.contains("solid"))).toBe(true);
    await expect.poll(() => contrastOf(page.locator("#sticky-bar"))).toBeGreaterThanOrEqual(4.5);
    await expect.poll(() => page.locator("#sticky-bar").evaluate((element) => getComputedStyle(element).backgroundColor)).not.toBe("rgb(255, 255, 255)");
  } finally {
    await context.close();
  }
});

test("Popup panels keep each other's changes (Focus toggle after Smart Dark)", async () => {
  const { context, worker } = await launch();
  try {
    await worker.evaluate(async () => { await chrome.storage.local.set({ awl_settings: { version: 9, enabled: true, activeProfileId: "study", siteRules: [] } }); });
    const popup = await context.newPage();
    const extensionId = new URL(worker.url()).host;
    // Opened as a tab, the popup's "active tab" is itself; its host stands in for a site.
    await popup.goto(`chrome-extension://${extensionId}/popup/index.html`);
    await popup.locator("summary", { hasText: "Appearance" }).click();
    await popup.locator(".theme-buttons button", { hasText: "Dark" }).click();
    await popup.locator(".appearance-engine select").selectOption("smart");
    await popup.locator("summary", { hasText: "Focus & Motion" }).click();
    // Toggles the active Study profile does not already turn on.
    await popup.getByLabel("Make sticky headers static").check();
    await popup.getByLabel("Pause autoplay media").check();

    await expect.poll(async () => (await worker.evaluate(async (host) => {
      const { awl_settings: settings } = await chrome.storage.local.get("awl_settings");
      return (settings as { siteRules: Array<{ hostname: string; appearance?: unknown; focus?: unknown; motion?: unknown }> }).siteRules.find((rule) => rule.hostname === host);
    }, extensionId))).toMatchObject({ appearance: { theme: "dark", engine: "smart" }, focus: { staticifyStickyHeaders: true }, motion: { pauseAutoplay: true } });
  } finally {
    await context.close();
  }
});
