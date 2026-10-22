// Captures the extension's real DOM snapshot of a fixture page, for eval cases.
//   npm run build && npm run fixtures   (in another terminal)
//   npx vite-node scripts/captureSnapshot.ts -- clutter.html
// Prints the snapshot JSON to stdout.

import { chromium } from "@playwright/test";
import path from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const EXTENSION_PATH = path.resolve(dirname(fileURLToPath(import.meta.url)), "../dist");
const FIXTURES_URL = process.env.FIXTURES_URL ?? "http://localhost:4173";
const page = process.argv.filter((value) => value.endsWith(".html")).pop() ?? "clutter.html";

async function main(): Promise<void> {
  const context = await chromium.launchPersistentContext("", {
    executablePath: process.env.CHROME_PATH,
    headless: false,
    viewport: { width: 1280, height: 800 },
    args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`, "--no-sandbox", "--headless=new"],
  });
  try {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker", { timeout: 10_000 });
    const tab = await context.newPage();
    await tab.goto(`${FIXTURES_URL}/${page}`, { waitUntil: "load" });
    await tab.waitForTimeout(300);
    const snapshot = await worker.evaluate(async (url) => {
      const [target] = await chrome.tabs.query({ url: `${url}/*` });
      return new Promise((resolve) => chrome.tabs.sendMessage(target.id!, { type: "GET_DOM_SNAPSHOT" }, (reply) => resolve(reply?.payload)));
    }, FIXTURES_URL);
    process.stdout.write(`${JSON.stringify(snapshot)}\n`);
  } finally {
    await context.close();
  }
}

void main();
