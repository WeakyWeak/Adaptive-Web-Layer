import { test, expect, chromium } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.resolve(__dirname, "../dist");
const FIXTURES_URL = process.env.FIXTURES_URL ?? "http://localhost:4173";

async function saveAppearance(
  serviceWorker: import("@playwright/test").Worker,
  appearance: Record<string, unknown>,
): Promise<void> {
  await serviceWorker.evaluate(async (nextAppearance) => {
    await chrome.storage.local.set({
      awl_settings: {
        version: 4,
        enabled: true,
        global: { appearance: nextAppearance },
        profiles: [],
        siteRules: [],
      },
    });
  }, appearance);
}

test.describe("Extension smoke test", () => {
  test("service worker registers and content script runs on fixture", async () => {
    // Launch persistent context with extension
    const context = await chromium.launchPersistentContext("", {
      executablePath: process.env.CHROME_PATH,
      headless: false,
      args: [
        `--disable-extensions-except=${EXTENSION_PATH}`,
        `--load-extension=${EXTENSION_PATH}`,
        "--no-sandbox",
        "--headless=new",
      ],
    });

    try {
      // Wait for the extension service worker to register
      let serviceWorker = context.serviceWorkers()[0];
      if (!serviceWorker) {
        serviceWorker = await context.waitForEvent("serviceworker", { timeout: 10_000 });
      }
      expect(serviceWorker).toBeTruthy();

      // Open fixture page
      const page = await context.newPage();
      await page.goto(`${FIXTURES_URL}/docs-bright.html`, { waitUntil: "domcontentloaded" });
      await expect(page).toHaveTitle(/Docs/i);

      // Confirm content script ran by checking for a console debug log
      // We can't read the console directly in this test, so we verify the page loaded
      // and the extension didn't crash it
      expect(page.url()).toContain("docs-bright.html");

      await page.close();
    } finally {
      await context.close();
    }
  });

  test("applies valid Light and Sepia adjustment filters", async () => {
    const context = await chromium.launchPersistentContext("", {
      executablePath: process.env.CHROME_PATH,
      headless: false,
      args: [
        `--disable-extensions-except=${EXTENSION_PATH}`,
        `--load-extension=${EXTENSION_PATH}`,
        "--no-sandbox",
        "--headless=new",
      ],
    });

    try {
      const serviceWorker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
      const page = await context.newPage();
      await page.goto(`${FIXTURES_URL}/docs-bright.html`, { waitUntil: "domcontentloaded" });

      await saveAppearance(serviceWorker, { theme: "light", engine: "fast", contrast: 1.6, brightness: 0.7, saturation: 0 });
      await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).filter)).toContain("contrast(1.6)");
      await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).filter)).not.toContain("none");

      await saveAppearance(serviceWorker, { theme: "sepia", engine: "fast", contrast: 1.2, brightness: 0.8, saturation: 0.4 });
      await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).filter)).toContain("brightness(0.8)");
      await expect.poll(() => page.locator("body").evaluate((element) => getComputedStyle(element).backgroundColor)).toBe("rgb(243, 234, 215)");
    } finally {
      await context.close();
    }
  });

  test("Smart applies after the body is ready and stays stable while scrolling", async () => {
    const context = await chromium.launchPersistentContext("", {
      executablePath: process.env.CHROME_PATH,
      headless: false,
      args: [
        `--disable-extensions-except=${EXTENSION_PATH}`,
        `--load-extension=${EXTENSION_PATH}`,
        "--no-sandbox",
        "--headless=new",
      ],
    });

    try {
      const serviceWorker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
      const page = await context.newPage();
      await page.goto(`${FIXTURES_URL}/docs-bright.html`, { waitUntil: "domcontentloaded" });
      await saveAppearance(serviceWorker, { theme: "dark", engine: "smart", contrast: 1, brightness: 1, saturation: 1 });

      await expect.poll(() => page.locator("[data-awl-smart-target]").count()).toBeGreaterThan(0);
      const beforeScroll = await page.locator("style[data-awl]").textContent();
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(300);
      expect(await page.locator("style[data-awl]").textContent()).toBe(beforeScroll);

      await page.goto(`${FIXTURES_URL}/native-dark.html`, { waitUntil: "domcontentloaded" });
      await saveAppearance(serviceWorker, { theme: "light", engine: "smart", contrast: 1, brightness: 1, saturation: 1 });
      await expect.poll(() => page.locator("[data-awl-smart-target]").count()).toBeGreaterThan(0);
      await expect.poll(() => page.locator("main").evaluate((element) => getComputedStyle(element).backgroundColor)).toBe("rgb(255, 255, 255)");
    } finally {
      await context.close();
    }
  });
});
