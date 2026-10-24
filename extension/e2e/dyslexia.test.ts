// P11 exit criteria in the real extension:
//   1. a scripted reading-fit test run (side panel UI, no AI, no network) saves
//      a profile that styles a fixture page exactly as the test's reader did;
//   2. the dyslexia lens finds every planted problem on dyslexia-hard.html,
//      "Apply all high-confidence fixes" raises "Score for you", Undo restores;
//   3. the dyslexia reading view on long-article.html goes draft → code check
//      → cloud review → preview over the page, with the original one click away
//      (stand-ins for llama-server and the proxy).
// Requires `npm run build` and `npm run fixtures` (FIXTURES_URL, default :4173).

import { test, expect, chromium, type BrowserContext, type Page, type Worker } from "@playwright/test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { FIT_PASSAGES } from "../src/shared/fitPassages";

const EXTENSION_PATH = path.resolve(dirname(fileURLToPath(import.meta.url)), "../dist");
const FIXTURES_URL = process.env.FIXTURES_URL ?? "http://localhost:4173";

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

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const TEXT_STYLE = ["fontFamily", "fontSize", "letterSpacing", "lineHeight"] as const;

test("a scripted reading-fit test saves a profile that styles a page exactly as the test showed it, with no network", async () => {
  test.setTimeout(90_000);
  const { context, worker, extensionId } = await launch();
  const requests: string[] = [];
  let recording = false;
  context.on("request", (request) => { if (recording && !request.url().startsWith("chrome-extension://")) requests.push(request.url()); });
  try {
    await worker.evaluate(async () => { await chrome.storage.local.set({ awl_settings: { version: 11, enabled: true, ai: { mode: "local", localEndpoint: "http://127.0.0.1:9" }, siteRules: [] } }); });
    const panel = await context.newPage();
    await panel.goto(`chrome-extension://${extensionId}/sidepanel/index.html`);
    await panel.getByText("Find my reading settings").click();
    // From here on (the panel's own model status check is done), nothing may leave the browser.
    await expect(panel.locator(".chip").first()).not.toHaveText("checking…");
    recording = true;
    await panel.getByRole("button", { name: "Start the test" }).click();
    // The reader reads fast (nothing counts for speed), so ties go to what felt easier:
    // Atkinson Hyperlegible, 18px, +0.12em, cream and 1.8 (rounds 3, 6, 8, 10 and 12).
    const easier = new Set([2, 5, 7, 9, 11]);
    for (let round = 0; ; round++) {
      const start = panel.getByRole("button", { name: "Start reading" });
      if (!await start.isVisible().catch(() => false)) {
        if (await panel.getByRole("button", { name: "Save as my profile" }).isVisible()) break;
        await start.waitFor({ timeout: 10_000 });
      }
      await expect(start).toBeEnabled({ timeout: 10_000 });
      await start.click();
      await panel.getByRole("button", { name: "Done" }).click();
      const prompt = await panel.locator(".fit-question legend").innerText();
      const passage = FIT_PASSAGES.find((item) => item.question.prompt === prompt)!;
      await panel.locator(".fit-question").getByRole("button", { name: passage.question.options[passage.question.answer], exact: true }).click();
      if (round > 0) await panel.getByRole("button", { name: easier.has(round) ? "Easier" : "About the same", exact: true }).click();
      await expect(panel.getByRole("button", { name: "Start reading" }).or(panel.getByRole("button", { name: "Save as my profile" }))).toBeVisible();
    }
    await expect(panel.locator(".fit-headline")).toContainText("Atkinson Hyperlegible font, 18px text, +0.12em letter spacing, a cream background, 1.8 line spacing");
    await expect(panel.getByText(/not a diagnosis/)).toBeVisible();
    await panel.getByRole("button", { name: "Save as my profile" }).click();
    await expect(panel.getByText(/turned on for every site/)).toBeVisible();
    const settings = await worker.evaluate(async () => (await chrome.storage.local.get("awl_settings")).awl_settings as { activeProfileId: string; profiles: Array<{ id: string; typography: Record<string, unknown>; appearance: Record<string, unknown>; dyslexiaLens?: boolean }> });
    const profile = settings.profiles.find((item) => item.id === settings.activeProfileId)!;
    expect(profile).toMatchObject({ typography: { fontFamily: "Atkinson Hyperlegible", fontSize: 18, letterSpacing: 0.12, lineHeight: 1.8 }, appearance: { backgroundTint: "cream" }, dyslexiaLens: true });
    const history = await worker.evaluate(async () => (await chrome.storage.local.get("awl_fit_history")).awl_fit_history as unknown[]);
    expect(history).toHaveLength(1);
    expect(requests).toEqual([]);
    recording = false;

    // The same settings in the test's reader and on a real page give the same text style and background.
    const shown = await panel.evaluate(async () => {
      const frame = document.createElement("iframe");
      frame.src = chrome.runtime.getURL("fitreader/index.html");
      document.body.append(frame);
      await new Promise<void>((resolve) => window.addEventListener("message", (event) => { if ((event.data as { type?: string }).type === "FIT_READY") resolve(); }));
      const rendered = new Promise<void>((resolve) => window.addEventListener("message", (event) => { if ((event.data as { type?: string }).type === "FIT_RENDERED") resolve(); }));
      frame.contentWindow!.postMessage({ type: "FIT_RENDER", id: "check", passage: { title: "Check", paragraphs: ["A paragraph long enough to be the article text of this reader page, so the region is found. ".repeat(6)] }, settings: { fontFamily: "Atkinson Hyperlegible", fontSize: 18, letterSpacing: 0.12, background: "cream", lineHeight: 1.8 } }, location.origin);
      await rendered;
      await new Promise((resolve) => setTimeout(resolve, 300));
      const doc = frame.contentDocument!;
      const paragraph = doc.querySelector("p")!;
      const style = getComputedStyle(paragraph);
      let behind: Element | null = paragraph;
      while (behind && getComputedStyle(behind).backgroundColor === "rgba(0, 0, 0, 0)") behind = behind.parentElement;
      return { fontFamily: style.fontFamily, fontSize: style.fontSize, letterSpacing: style.letterSpacing, lineHeight: style.lineHeight, background: behind ? getComputedStyle(behind).backgroundColor : "" };
    });
    const page = await context.newPage();
    await page.goto(`${FIXTURES_URL}/long-article.html`, { waitUntil: "load" });
    await expect.poll(() => page.locator("article p").first().evaluate((element) => getComputedStyle(element).fontFamily)).toContain("Atkinson Hyperlegible");
    const onPage = await page.locator("article p").first().evaluate((element) => {
      const style = getComputedStyle(element);
      return { fontFamily: style.fontFamily, fontSize: style.fontSize, letterSpacing: style.letterSpacing, lineHeight: style.lineHeight };
    });
    for (const key of TEXT_STYLE) expect(onPage[key], key).toBe(shown[key]);
    expect(shown.background).toBe("rgb(253, 246, 227)");
    // The colour painted behind the article text is the same tint.
    await expect.poll(() => page.locator("article p").first().evaluate((paragraph) => {
      let behind: Element | null = paragraph;
      while (behind && getComputedStyle(behind).backgroundColor === "rgba(0, 0, 0, 0)") behind = behind.parentElement;
      return behind ? getComputedStyle(behind).backgroundColor : "";
    })).toBe(shown.background);
  } finally {
    await context.close();
  }
});

interface InspectState { report?: { lens?: boolean; findings: Array<{ id: string; type: string; confidence: string; suggestedFix?: unknown }>; score: { value: number } }; previousScore?: number }
const inspectState = (panel: Page, tabId: number) => panel.evaluate(async (id) => (await chrome.storage.session.get(`awl_inspect_${id}`))[`awl_inspect_${id}`] as InspectState | undefined, tabId);

test("dyslexia lens: every planted problem found on dyslexia-hard.html; fixes raise the score for you; Undo restores", async () => {
  const { context, worker, extensionId } = await launch();
  try {
    // A profile with only the lens on, so the page shows its own styles.
    await worker.evaluate(async () => { await chrome.storage.local.set({ awl_settings: { version: 11, enabled: true, ai: { mode: "local", localEndpoint: "http://127.0.0.1:9" }, activeProfileId: "lens", profiles: [{ id: "lens", name: "Lens only", dyslexiaLens: true }], siteRules: [] } }); });
    const { page, panel, tabId } = await open(context, worker, extensionId, "dyslexia-hard.html");
    const lede = () => page.locator(".lede").evaluate((element) => { const style = getComputedStyle(element); return { fontStyle: style.fontStyle, textAlign: style.textAlign }; });
    const code = () => page.locator("pre").evaluate((element) => { const style = getComputedStyle(element); return { fontStyle: style.fontStyle, textTransform: style.textTransform, textAlign: style.textAlign }; });
    const codeBefore = await code();

    await panel.getByRole("button", { name: "Inspect this page" }).click();
    await expect(panel.getByLabel(/Score for you \d+ out of 100/)).toBeVisible();
    const report = (await inspectState(panel, tabId))!.report!;
    expect(report.lens).toBe(true);
    const types = new Set(report.findings.map((finding) => finding.type));
    for (const type of ["justified-text", "italic-body", "all-caps-text", "long-sentences", "long-words", "glare", "huge-block"]) expect(types, type).toContain(type);
    const before = report.score.value;

    await panel.getByRole("button", { name: /Apply all high-confidence fixes/ }).click();
    await expect.poll(async () => (await inspectState(panel, tabId))?.previousScore).toBe(before);
    const after = (await inspectState(panel, tabId))!.report!;
    expect(after.score.value).toBeGreaterThan(before);
    const fixedTypes = new Set(after.findings.map((finding) => finding.type));
    for (const type of ["justified-text", "italic-body", "glare"]) expect(fixedTypes, type).not.toContain(type);
    expect(await lede()).toEqual({ fontStyle: "normal", textAlign: "start" });
    // Code keeps its own look.
    expect(await code()).toEqual(codeBefore);

    await panel.getByRole("button", { name: "Undo fixes" }).click();
    await expect.poll(async () => (await inspectState(panel, tabId))?.report?.score.value).toBe(before);
    expect(await lede()).toEqual({ fontStyle: "italic", textAlign: "justify" });
  } finally {
    await context.close();
  }
});

/** A stand-in llama-server: a faithful reading view (each paragraph kept) and a 3-bullet summary. */
function fakeLlama(): Server {
  return createServer((req, res) => {
    if (req.url === "/v1/models") { res.end(JSON.stringify({ data: [{ id: "fake.gguf" }] })); return; }
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const messages = (JSON.parse(body) as { messages: Array<{ content: string }> }).messages;
      const text = messages[1].content.split("<page_data>\n")[1]?.split("\n</page_data>")[0] ?? "";
      const reply = messages[0].content.includes("reading view")
        ? { blocks: text.split("\n\n").filter(Boolean).map((paragraph) => ({ kind: "paragraph", text: paragraph, items: [] })) }
        : { bullets: ["The article explains the topic.", "It gives several examples.", "It ends with advice."], readingMinutes: 3, keyTerms: [] };
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(reply) } }] })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
}

/** A stand-in proxy whose reviewer finds no meaning errors; it records what it was sent. */
function reviewingProxy(received: string[]): Server {
  return createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      if (req.url === "/health") { res.end(JSON.stringify({ ok: true, backends: { gemini: true } })); return; }
      received.push(body);
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      res.end(`${JSON.stringify({ type: "result", data: { issues: [] }, modelId: "gemini-3.5-flash" })}\n`);
    });
  });
}

interface UnderstandState { readingView?: { shown: boolean; source: string; summary: string[]; blocks: unknown[]; checks: { review: string; reviewedParts: number; flagged: number } }; error?: { message: string } }
const understand = (panel: Page, tabId: number) => panel.evaluate(async (id) => (await chrome.storage.session.get(`awl_understand_${id}`))[`awl_understand_${id}`] as UnderstandState | undefined, tabId);

test("dyslexia reading view: local draft, code check, cloud review, preview over the page, original one click away", async () => {
  const received: string[] = [];
  const llama = fakeLlama();
  const proxy = reviewingProxy(received);
  const [localEndpoint, cloudProxyUrl] = [await listen(llama), await listen(proxy)];
  const { context, worker, extensionId } = await launch();
  try {
    await worker.evaluate(async (ai) => {
      await chrome.storage.local.set({ awl_settings: { version: 11, enabled: true, ai, privacy: { cloudSiteConsents: { localhost: "allow" }, cloudTextSites: { localhost: true } }, siteRules: [] } });
    }, { mode: "hybrid", localEndpoint, cloudProxyUrl, cloudProxyToken: "t" });
    const { page, panel, tabId } = await open(context, worker, extensionId, "long-article.html");
    const original = await page.locator("main").innerText();

    await panel.getByRole("button", { name: "Dyslexia reading view" }).click();
    await expect.poll(async () => (await understand(panel, tabId))?.readingView?.checks.review, { timeout: 20_000 }).toBe("reviewed");
    const view = (await understand(panel, tabId))!.readingView!;
    expect(view).toMatchObject({ shown: true, source: "local", checks: { flagged: 0 } });
    expect(view.summary).toHaveLength(3);
    expect(view.blocks.length).toBeGreaterThan(3);
    // The reviewer saw page text (consent was given) and the draft.
    expect(received.length).toBeGreaterThan(0);
    expect(received[0]).toContain("<rewrite>");
    await expect(page.locator("[data-awl-overlay='reading-view']")).toBeVisible();
    // "Show original" hides the view and leaves a button to bring it back (its host is a zero-size box; read its display).
    const pill = () => page.locator("[data-awl-overlay='reading-view-pill']").evaluate((element) => getComputedStyle(element).display);
    expect(await pill()).toBe("none");
    // (Closed shadow roots: drive it like a keyboard and mouse user would.)
    await page.keyboard.press("Escape");
    await expect(page.locator("[data-awl-overlay='reading-view']")).toBeHidden();
    await expect.poll(pill).toBe("block");
    await page.keyboard.press("Enter"); // the pill has focus
    await expect(page.locator("[data-awl-overlay='reading-view']")).toBeVisible();
    expect(await pill()).toBe("none");
    await expect(panel.getByText(/Reviewed by the cloud: \d+ of \d+ part/)).toBeVisible();

    // The page underneath never changed; "Back to the original" closes the view.
    expect(await page.locator("main").innerText()).toBe(original);
    await panel.getByRole("button", { name: "Back to the original" }).click();
    await expect(page.locator("[data-awl-overlay='reading-view']")).toHaveCount(0);
    await expect.poll(async () => (await understand(panel, tabId))?.readingView?.shown).toBe(false);
    // And it comes back from the saved result, without asking the model again.
    const calls = received.length;
    await panel.getByRole("button", { name: "Show the reading view" }).click();
    await expect(page.locator("[data-awl-overlay='reading-view']")).toHaveCount(1);
    expect(received.length).toBe(calls);
  } finally {
    await context.close();
    llama.close();
    proxy.close();
  }
});

test("plain reading view: the main content as written, no AI, no summary, over an unchanged page", async () => {
  const { context, worker, extensionId } = await launch();
  try {
    await worker.evaluate(async () => { await chrome.storage.local.set({ awl_settings: { version: 11, enabled: true, ai: { mode: "local", localEndpoint: "http://127.0.0.1:9" }, siteRules: [] } }); });
    const { page, panel } = await open(context, worker, extensionId, "long-article.html");
    const original = await page.locator("main").innerText();
    await panel.getByRole("button", { name: "Plain reading view" }).click();
    await expect(page.locator("[data-awl-overlay='reading-view']")).toBeVisible();
    // The overlay is a closed shadow root: read its text through DevTools (which sees closed roots).
    const cdp = await context.newCDPSession(page);
    type DomNode = { nodeType: number; nodeValue: string; attributes?: string[]; children?: DomNode[]; shadowRoots?: DomNode[] };
    const { root } = await cdp.send("DOM.getDocument", { depth: -1, pierce: true }) as { root: DomNode };
    const textOf = (node: DomNode): string => node.nodeType === 3 ? node.nodeValue : [...(node.shadowRoots ?? []), ...(node.children ?? [])].map(textOf).join(" ");
    // attributes is a flat [name, value, name, value…] list.
    const isOverlay = (node: DomNode) => (node.attributes ?? []).some((value, index, list) => index % 2 === 1 && list[index - 1] === "data-awl-overlay" && value === "reading-view");
    const find = (node: DomNode): DomNode | null => isOverlay(node) ? node : [...(node.shadowRoots ?? []), ...(node.children ?? [])].map(find).find(Boolean) ?? null;
    const shown = textOf(find(root)!).replace(/\s+/g, " ");
    expect(shown).toContain("Reading view");
    expect(shown).toContain("Original text, no AI");
    expect(shown).not.toContain("In short");
    // Every paragraph of the article appears, word for word.
    const paragraphs = await page.locator("article p").allInnerTexts();
    for (const paragraph of paragraphs.filter((text) => text.trim().length > 40).slice(0, 5)) expect(shown).toContain(paragraph.replace(/\s+/g, " ").trim().slice(0, 60));
    expect(await page.locator("main").innerText()).toBe(original);
    await page.keyboard.press("Escape");
    await expect(page.locator("[data-awl-overlay='reading-view']")).toBeHidden();
  } finally {
    await context.close();
  }
});

/** A stand-in model that, like the 7B one, answers "red links, underlined" with the colour only. */
function colourOnlyLlama(): Server {
  return createServer((req, res) => {
    if (req.url === "/v1/models") { res.end(JSON.stringify({ data: [{ id: "fake.gguf" }] })); return; }
    req.resume();
    req.on("end", () => {
      const plan = { interpretedRequest: "Red links", changes: { linkColor: "red" }, reasons: ["red links"], confidence: 0.9 };
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(plan) } }] })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
}

test("\"make the links red and underline it\": links turn a readable red and get underlined", async () => {
  const llama = colourOnlyLlama();
  const localEndpoint = await listen(llama);
  const { context, worker, extensionId } = await launch();
  try {
    await worker.evaluate(async (endpoint) => { await chrome.storage.local.set({ awl_settings: { version: 11, enabled: true, ai: { mode: "local", localEndpoint: endpoint }, siteRules: [] } }); }, localEndpoint);
    const { page, panel, tabId } = await open(context, worker, extensionId, "a11y-clean.html");
    const link = () => page.locator("main p a[href]").first().evaluate((element) => { const style = getComputedStyle(element); return { color: style.color, underline: style.textDecorationLine }; });
    expect((await link()).color).not.toBe("rgb(179, 38, 30)");
    expect((await send(panel, { type: "AI_RUN", tabId, request: "make the links red and underline it", kind: "ask" })).ok).toBe(true);
    await expect.poll(async () => (await panel.evaluate(async (id) => ((await chrome.storage.session.get(`awl_job_${id}`))[`awl_job_${id}`] as { status: string }).status, tabId))).toBe("preview");
    const job = await panel.evaluate(async (id) => (await chrome.storage.session.get(`awl_job_${id}`))[`awl_job_${id}`] as { changes: Record<string, unknown>; warnings?: string[] }, tabId);
    expect(job.changes).toEqual({ linkColor: "red", underlineLinks: true });
    expect(job.warnings?.join(" ")).toMatch(/asked for it by name/);
    await expect.poll(link).toEqual({ color: "rgb(179, 38, 30)", underline: "underline" });
    expect((await send(panel, { type: "AI_APPLY", tabId })).ok).toBe(true);
    await page.reload();
    await expect.poll(link).toEqual({ color: "rgb(179, 38, 30)", underline: "underline" });
  } finally {
    await context.close();
    llama.close();
  }
});
