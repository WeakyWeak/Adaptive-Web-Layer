// A pop-up that locks scrolling (overflow: hidden on html/body) while open:
// hiding it through a saved element rule must give scrolling back, and undoing
// the rule must restore the site exactly. Requires `npm run build` and
// `npm run fixtures` (FIXTURES_URL, default :4173).

import { test, expect, chromium } from "@playwright/test";
import path from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const EXTENSION_PATH = path.resolve(dirname(fileURLToPath(import.meta.url)), "../dist");
const FIXTURES_URL = process.env.FIXTURES_URL ?? "http://localhost:4173";

test("hiding a pop-up that locked scrolling gives scrolling back", async () => {
  const context = await chromium.launchPersistentContext("", {
    executablePath: process.env.CHROME_PATH,
    headless: false,
    args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`, "--no-sandbox", "--headless=new"],
  });
  try {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker", { timeout: 10_000 });
    const page = await context.newPage();
    await page.goto(`${FIXTURES_URL}/scroll-lock.html`, { waitUntil: "load" });
    // The reader's wheel, not script: overflow: hidden blocks only the reader's scrolling.
    const scrolls = async () => {
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.mouse.move(300, 300);
      await page.mouse.wheel(0, 600);
      await page.waitForTimeout(300);
      return page.evaluate(() => window.scrollY > 0);
    };
    expect(await scrolls()).toBe(false);

    await worker.evaluate(async () => {
      await chrome.storage.local.set({ awl_settings: { version: 10, enabled: true, siteRules: [{ hostname: "localhost", focus: { hiddenSelectors: [".nl-modal"] } }] } });
    });
    await expect.poll(() => page.locator(".nl-modal").evaluate((element) => getComputedStyle(element).display)).toBe("none");
    await expect.poll(scrolls).toBe(true);
    expect(await page.locator("h1").isVisible()).toBe(true);

    await worker.evaluate(async () => {
      await chrome.storage.local.set({ awl_settings: { version: 10, enabled: true, siteRules: [] } });
    });
    await expect.poll(() => page.locator(".nl-modal").evaluate((element) => getComputedStyle(element).display)).toBe("grid");
    await expect.poll(scrolls).toBe(false);
  } finally {
    await context.close();
  }
});
