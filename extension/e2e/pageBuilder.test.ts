// Robustness on page-builder sites (no <main>/<article>, shared class names),
// in the real extension, with stand-ins for llama-server and the proxy:
//   the local draft hides the article column, dims the title and narrows the
//   column, and the stand-in reviewer approves it (as Gemini sometimes does).
//   Code still keeps the article and the title, and undoes the width change
//   because the page's lines are already a comfortable length.
// Requires `npm run build` and `npm run fixtures` (FIXTURES_URL, default :4173).

import { test, expect, chromium, type BrowserContext, type Page, type Worker } from "@playwright/test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const EXTENSION_PATH = path.resolve(dirname(fileURLToPath(import.meta.url)), "../dist");
const FIXTURES_URL = process.env.FIXTURES_URL ?? "http://localhost:4173";
const FIXTURE = "page-builder-article.html";

async function launch(): Promise<{ context: BrowserContext; worker: Worker; extensionId: string }> {
  const context = await chromium.launchPersistentContext("", {
    executablePath: process.env.CHROME_PATH,
    headless: false,
    viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`, "--no-sandbox", "--headless=new"],
  });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker", { timeout: 10_000 });
  return { context, worker, extensionId: new URL(worker.url()).host };
}

/** Ids of the prompt's BLOCKS lines whose text preview contains `text`. */
function idsOf(prompt: string, text: string): string[] {
  return prompt.split("\n").filter((row) => /^s\d+ </.test(row) && row.includes(text)).map((row) => row.split(" ")[0]);
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** A careless local draft: hides everything holding the article, dims the title, narrows the column. */
function fakeLlama(prompts: string[]): Server {
  return createServer((req, res) => {
    if (req.url === "/v1/models") { res.end(JSON.stringify({ data: [{ id: "fake.gguf" }] })); return; }
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const prompt = (JSON.parse(body) as { messages: Array<{ content: string }> }).messages[1].content;
      prompts.push(prompt);
      const plan = {
        interpretedRequest: "Hide clutter",
        changes: { maxContentWidth: 1000 },
        elements: { hide: [...idsOf(prompt, "Summarize with AI"), ...idsOf(prompt, "We are acquiring")], dim: idsOf(prompt, "12 Websites with Confusing Design"), highlight: [] },
        expand: [],
        reasons: ["clutter"],
        confidence: 0.9,
      };
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(plan) } }] })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
}

/** A reviewer that misses the mistakes and approves. */
function approvingProxy(): Server {
  return createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      if (req.url === "/health") { res.end(JSON.stringify({ ok: true, backends: { gemini: true } })); return; }
      const review = { verdict: "approve", drop: [], add: { changes: {}, elements: { hide: [], dim: [], highlight: [] } }, missedRegions: [], notes: "Looks good." };
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      res.end(`${JSON.stringify({ type: "result", data: review, modelId: "gemini-3.5-flash" })}\n`);
    });
  });
}

interface Job { status: string; changes?: Record<string, unknown>; rejectedElements?: Array<{ label: string; reason: string }>; supervision?: { review: string; ledger: Array<{ ref: string; label: string; status: string; reason?: string }> } }
const job = (panel: Page, tabId: number) => panel.evaluate(async (id) => (await chrome.storage.session.get(`awl_job_${id}`))[`awl_job_${id}`] as Job | undefined, tabId);
const send = (panel: Page, message: Record<string, unknown>) =>
  panel.evaluate((msg) => new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve)), message) as Promise<{ ok: boolean; error?: string }>;
const style = (page: Page, selector: string) => page.locator(selector).first().evaluate((element) => {
  const computed = getComputedStyle(element);
  return { display: computed.display, opacity: computed.opacity, filter: computed.filter };
});

test("page-builder site: code keeps the article and the title, and leaves a comfortable width alone, even when the reviewer approves a bad draft", async () => {
  const prompts: string[] = [];
  const llama = fakeLlama(prompts);
  const proxy = approvingProxy();
  const [localEndpoint, cloudProxyUrl] = [await listen(llama), await listen(proxy)];
  const { context, worker, extensionId } = await launch();
  try {
    await worker.evaluate(async (ai) => {
      await chrome.storage.local.set({ awl_settings: { version: 10, enabled: true, ai, privacy: { cloudSiteConsents: { localhost: "allow" } }, profiles: [], siteRules: [] } });
    }, { mode: "hybrid", localEndpoint, cloudProxyUrl, cloudProxyToken: "t" });
    const page = await context.newPage();
    await page.goto(`${FIXTURES_URL}/${FIXTURE}`, { waitUntil: "load" });
    const panel = await context.newPage();
    await panel.goto(`chrome-extension://${extensionId}/sidepanel/index.html`);
    const tabId = await worker.evaluate(async (url) => (await chrome.tabs.query({ url }))[0]?.id, `${FIXTURES_URL}/${FIXTURE}`) as number;
    await page.bringToFront();

    expect((await send(panel, { type: "AI_RUN", tabId, request: "Hide the clutter and make this easier to read", kind: "ask" })).ok).toBe(true);
    await expect.poll(async () => (await job(panel, tabId))?.supervision?.review, { timeout: 20_000 }).toBe("reviewed");
    const result = (await job(panel, tabId))!;

    // The model was told which block is the article and which holds the title.
    expect(prompts[0]).toMatch(/MAIN CONTENT/);
    expect(prompts[0]).toMatch(/PAGE TITLE/);
    // The article column and the title were refused by code, whatever the reviewer said.
    const reasons = (result.rejectedElements ?? []).map((item) => item.reason).join(" | ");
    expect(reasons).toMatch(/main content|page's text/);
    expect(reasons).toMatch(/page title/);
    // The width change nobody asked for is undone: the lines were already a comfortable length.
    expect(result.changes?.maxContentWidth).toBeUndefined();
    expect(result.supervision?.ledger.find((entry) => entry.ref === "maxContentWidth")).toMatchObject({ status: "reverted", reason: expect.stringMatching(/comfortable length/) });

    // On the page: the article and the title are untouched; the notice bar may go.
    await expect.poll(() => style(page, ".post-content")).toMatchObject({ display: "block", opacity: "1" });
    expect(await style(page, ".hero h1")).toMatchObject({ opacity: "1" });
    expect(await style(page, ".hero")).toMatchObject({ opacity: "1" });
    await expect.poll(() => style(page, ".notice")).toMatchObject({ display: "none" });
  } finally {
    await context.close();
    llama.close();
    proxy.close();
  }
});
