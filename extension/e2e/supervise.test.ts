// P10 supervised fix in the real extension, with stand-ins for llama-server
// (the local drafter) and the local proxy (the cloud reviewer):
//   hybrid: the local draft hides the table of contents and the site header by
//   mistake. Code catches the first (the score drops) and undoes it; the
//   reviewer drops the second and adds the sale strip the draft missed; the
//   page shows the reviewed result; Apply survives a reload; Undo restores.
//   local: the same draft is measured (code still undoes the table-of-contents
//   hide) but never reviewed, and the proxy gets no request at all.
// Requires `npm run build` and `npm run fixtures` (FIXTURES_URL, default :4173).

import { test, expect, chromium, type BrowserContext, type Page, type Worker } from "@playwright/test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const EXTENSION_PATH = path.resolve(dirname(fileURLToPath(import.meta.url)), "../dist");
const FIXTURES_URL = process.env.FIXTURES_URL ?? "http://localhost:4173";
const FIXTURE = "obfuscated-clutter.html";

async function launch(): Promise<{ context: BrowserContext; worker: Worker; extensionId: string }> {
  const context = await chromium.launchPersistentContext("", {
    executablePath: process.env.CHROME_PATH,
    headless: false,
    args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`, "--no-sandbox", "--headless=new"],
  });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker", { timeout: 10_000 });
  return { context, worker, extensionId: new URL(worker.url()).host };
}

/** The snapshot id of the block whose text preview contains `text`, read from a prompt's BLOCKS list. */
function idOf(prompt: string, text: string): string {
  const line = prompt.split("\n").find((row) => /^s\d+ </.test(row) && row.includes(text));
  if (!line) throw new Error(`no block with "${text}" in the prompt`);
  return line.split(" ")[0];
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** llama-server stand-in: hides the consent banner and, by mistake, the table of contents and the site header. */
function fakeLlama(): Server {
  return createServer((req, res) => {
    if (req.url === "/v1/models") { res.end(JSON.stringify({ data: [{ id: "fake.gguf" }] })); return; }
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const prompt = (JSON.parse(body) as { messages: Array<{ content: string }> }).messages[1].content;
      const plan = { interpretedRequest: "Hide clutter", changes: {}, elements: { hide: [idOf(prompt, "[x9a3f]"), idOf(prompt, "[c1z]"), idOf(prompt, "[q7lk]")], dim: [], highlight: [] }, expand: [], reasons: ["clutter"], confidence: 0.8 };
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(plan) } }] })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
}

/** Proxy stand-in: the reviewer keeps the site header and adds the sale strip. */
function fakeProxy(received: string[]): Server {
  return createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      received.push(req.url ?? "");
      if (req.url === "/health") { res.end(JSON.stringify({ ok: true, backends: { gemini: true } })); return; }
      const prompt = (JSON.parse(body) as { userPrompt: string }).userPrompt;
      const review = {
        verdict: "revise",
        drop: [{ ref: idOf(prompt, "[q7lk]"), reason: "This is the site header with the navigation." }],
        add: { changes: {}, elements: { hide: [idOf(prompt, "[mm42]")], dim: [], highlight: [] } },
        missedRegions: [],
        notes: "Kept the site header and hid the flash-sale strip.",
      };
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      res.end(`${JSON.stringify({ type: "ping" })}\n${JSON.stringify({ type: "result", data: review, modelId: "gemini-3.5-flash" })}\n`);
    });
  });
}

interface Job { status: string; elements?: Array<{ id: string }>; supervision?: { review: string; reviewer?: string; ledger: Array<{ ref: string; label: string; status: string; source: string; reason?: string }> } }
const job = (panel: Page, tabId: number) => panel.evaluate(async (id) => (await chrome.storage.session.get(`awl_job_${id}`))[`awl_job_${id}`] as Job | undefined, tabId);
const send = (panel: Page, message: Record<string, unknown>) =>
  panel.evaluate((msg) => new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve)), message) as Promise<{ ok: boolean; error?: string }>;
const display = (page: Page, selector: string) => page.locator(selector).first().evaluate((element) => getComputedStyle(element).display);
const CLEAN = "Clean this page: hide clutter like cookie banners, pop-ups, promos and recommendation rails; keep the main content and navigation";

async function setUp(mode: "hybrid" | "local", received: string[]) {
  const llama = fakeLlama();
  const proxy = fakeProxy(received);
  const [localEndpoint, cloudProxyUrl] = [await listen(llama), await listen(proxy)];
  const { context, worker, extensionId } = await launch();
  await worker.evaluate(async (ai) => {
    await chrome.storage.local.set({ awl_settings: { version: 10, enabled: true, ai, privacy: { cloudSiteConsents: { localhost: "allow" } }, profiles: [], siteRules: [] } });
  }, { mode, localEndpoint, cloudProxyUrl, cloudProxyToken: "t" });
  const page = await context.newPage();
  await page.goto(`${FIXTURES_URL}/${FIXTURE}`, { waitUntil: "load" });
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel/index.html`);
  const tabId = await worker.evaluate(async (url) => (await chrome.tabs.query({ url }))[0]?.id, `${FIXTURES_URL}/${FIXTURE}`) as number;
  await page.bringToFront();
  return { context, page, panel, tabId, close: async () => { await context.close(); llama.close(); proxy.close(); } };
}

test("hybrid: the cloud reviewer corrects the local draft, and the page shows the reviewed result", async () => {
  const received: string[] = [];
  const { page, panel, tabId, close } = await setUp("hybrid", received);
  try {
    expect((await send(panel, { type: "AI_RUN", tabId, request: CLEAN, kind: "clean" })).ok).toBe(true);
    await expect.poll(async () => (await job(panel, tabId))?.supervision?.review, { timeout: 20_000 }).toBe("reviewed");
    const reviewed = (await job(panel, tabId))!;
    expect(reviewed.status).toBe("preview");
    expect(reviewed.supervision?.reviewer).toBe("gemini-3.5-flash");
    const ledger = reviewed.supervision!.ledger;
    const entry = (text: string) => ledger.find((item) => item.label.includes(text));
    expect(entry("We value your privacy")).toMatchObject({ status: "kept", source: "local" });
    expect(entry("On this page")).toMatchObject({ status: "reverted", reason: expect.stringMatching(/score fell/) });
    expect(entry("Riverside Library")).toMatchObject({ status: "dropped", source: "cloud" });
    expect(entry("FLASH SALE")).toMatchObject({ status: "added", source: "cloud" });
    expect(received).toContain("/v1/analyze");

    // Clutter with random class names is hidden; the table of contents and navigation stay.
    await expect.poll(() => display(page, ".x9a3f")).toBe("none");
    await expect.poll(() => display(page, ".mm42")).toBe("none");
    expect(await display(page, ".c1z")).not.toBe("none");
    expect(await display(page, "nav")).not.toBe("none");

    // The side panel shows the review: stepper, reviewer, and the removed item with its reason.
    await expect(panel.getByText("Reviewed by gemini-3.5-flash")).toBeVisible();
    await expect(panel.getByText("This is the site header with the navigation.", { exact: false })).toBeVisible();
    await expect(panel.getByRole("list", { name: "Progress" })).toBeVisible();

    expect((await send(panel, { type: "AI_APPLY", tabId })).ok).toBe(true);
    await page.reload({ waitUntil: "load" });
    await expect.poll(() => display(page, ".x9a3f")).toBe("none");
    expect(await display(page, ".mm42")).toBe("none");
    expect(await display(page, ".c1z")).not.toBe("none");
    expect((await send(panel, { type: "AI_UNDO", tabId })).ok).toBe(true);
    await expect.poll(() => display(page, ".x9a3f")).not.toBe("none");
  } finally {
    await close();
  }
});

test("local mode: the draft is measured but never reviewed, and nothing reaches the proxy", async () => {
  const received: string[] = [];
  const { page, panel, tabId, close } = await setUp("local", received);
  try {
    expect((await send(panel, { type: "AI_RUN", tabId, request: CLEAN, kind: "clean" })).ok).toBe(true);
    await expect.poll(async () => (await job(panel, tabId))?.status, { timeout: 20_000 }).toBe("preview");
    const draft = (await job(panel, tabId))!;
    expect(draft.supervision?.review).toBe("off");
    await expect(panel.getByText("Not reviewed", { exact: true })).toBeVisible();
    // Without a reviewer, code still measures: the consent banner goes, the
    // table-of-contents hide is undone (the score fell), the header waits for a tick.
    await expect.poll(() => display(page, ".x9a3f")).toBe("none");
    expect(await display(page, ".c1z")).not.toBe("none");
    expect(await display(page, ".q7Lk")).not.toBe("none");
    expect(received.filter((url) => url !== "/health")).toEqual([]);
  } finally {
    await close();
  }
});
