// ─── Comprehension jobs (background only) ────────────────────────────────────
// TL;DR and glossary for the page, and simplify / define / translate for a
// selection. Flow: page text → cache → mask → chunk → model or Sarvam → checks →
// unmask → per-tab state (side panel) + message to the page (card, popover,
// underlines). The page's own text is never changed.

import { chunkText } from "../shared/chunk";
import {
  GlossaryResultSchema,
  MAX_DEFINITION_WORDS,
  readingMinutes,
  readUnderstand,
  SelectionResultSchema,
  SummaryResultSchema,
  understandKey,
  UnderstandStateSchema,
  verifyBullets,
  verifyGlossary,
  hasDevanagari,
  type ComprehensionKind,
  type GlossaryResult,
  type GlossaryTerm,
  type PageKind,
  type ResultSource,
  type SelectionResult,
  type SummaryResult,
  type UnderstandState,
} from "../shared/comprehension";
import { cacheKey, readCache, writeCache } from "../shared/comprehensionCache";
import { DEFAULT_TARGET, SOURCE_LANGUAGE, TRANSLATE_CHUNK_CHARS } from "../shared/languages";
import { GlossaryShownSchema, PageTextSchema, type UnderstandSelection } from "../shared/messages";
import { formatProviderError, ProviderError, toProviderError } from "../shared/plan";
import { ProviderRouter } from "../shared/providerRouter";
import { checkFidelity, FidelityReplySchema, type FidelityIssue } from "../shared/review";
import { zodToJsonSchema } from "../shared/jsonSchema";
import { cloudConsentFor, cloudTextAllowed, type Settings } from "../shared/settings";
import { loadSettings } from "../shared/storage";
import { mask, stripCodeMarks, unmask } from "../shared/textMask";
import { runComprehension } from "./comprehensionModel";
import { consumeAllowOnce } from "./consent";
import { buildFidelitySystemPrompt, buildFidelityUserPrompt } from "./reviewPrompt";
import { runValidated } from "./structured";
import { beginJob, endJob, enqueue } from "./jobs";
import { tabMessage, tabPage, tell } from "./tabs";
import type { StructuredGenerator } from "./planner";

/** Summaries of long pages read at most this many chunks, then merge them. */
const MAX_SUMMARY_CHUNKS = 3;
const MIN_PAGE_CHARS = 200;
const LOCAL_TRANSLATE_CHUNK_CHARS = 1500;
const CLOUD_TEXT_BUDGET = 48_000;

// ── State (chrome.storage.session, one record per tab) ──────────────────────
function updateState(tabId: number, change: (state: UnderstandState) => UnderstandState): Promise<UnderstandState> {
  return enqueue(`understand:${tabId}`, async () => {
    const current = (await readUnderstand(tabId)) ?? { tabId, url: "", updatedAt: 0 };
    const next = UnderstandStateSchema.parse({ ...change(current), updatedAt: Date.now() });
    await chrome.storage.session.set({ [understandKey(tabId)]: next });
    return next;
  });
}

export function clearUnderstand(tabId: number): Promise<void> {
  return enqueue(`understand:${tabId}`, () => chrome.storage.session.remove(understandKey(tabId)));
}

/** On worker start, a "running" marker from a dead worker is stale. */
export async function failOrphanedUnderstand(): Promise<void> {
  const all = await chrome.storage.session.get(null);
  for (const [key, value] of Object.entries(all)) {
    const parsed = UnderstandStateSchema.safeParse(value);
    if (!key.startsWith("awl_understand_") || !parsed.success || !parsed.data.running) continue;
    const { kind } = parsed.data.running;
    await updateState(parsed.data.tabId, (state) => ({ ...state, running: undefined, error: { kind, code: "network", message: "The extension restarted while the AI was working.", hint: "Run it again." } }));
  }
}

/** Characters of (masked) page text one model call may carry. */
function textBudget(settings: Settings): number {
  if (settings.ai.mode === "cloud") return CLOUD_TEXT_BUDGET;
  return Math.max(3000, (settings.ai.localContextSize - 1500) * 3);
}

export interface Runner {
  settings: Settings;
  /** The routed model (null in Demo mode). */
  router: StructuredGenerator | null;
  signal: AbortSignal;
  /** Sarvam through the router (cloud only, consent-gated). */
  translate(text: string, target: string): Promise<string>;
  /**
   * P10: the cloud reviewer checks a (masked) rewrite against its (masked)
   * original. null when not allowed: local mode, Demo mode, or no page-text
   * consent for this site.
   */
  reviewText(original: string, rewrite: string, checks: readonly FidelityIssue[]): Promise<FidelityIssue[] | null>;
  source(): ResultSource;
}

/** Shared job bookkeeping: running marker, cancellation, errors, allow-once. */
async function runJob(tabId: number, kind: ComprehensionKind, hostname: string, url: string, work: (runner: Runner) => Promise<void>, onError?: (error: ProviderError) => Promise<void>): Promise<void> {
  const settings = await loadSettings();
  const signal = beginJob(tabId, "understand");
  const router = settings.ai.demoMode ? null : new ProviderRouter({ settings: settings.ai, consent: cloudConsentFor(settings.privacy, hostname) });
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await updateState(tabId, (state) => ({ ...(state.url === url ? state : { tabId, updatedAt: 0 }), url, running: { id, kind, stage: "Reading", startedAt: Date.now() }, error: undefined }));
  let usedSarvam = false;
  let usedReviewer = false;
  const runner: Runner = {
    settings,
    router,
    signal,
    translate: async (text, target) => {
      if (!router) throw new ProviderError("unsupported", "Demo mode does not translate.");
      const translated = await router.translate({ text, source: SOURCE_LANGUAGE, target, signal });
      usedSarvam = true;
      return translated;
    },
    reviewText: async (original, rewrite, checks) => {
      if (!router || settings.ai.mode === "local" || !cloudTextAllowed(settings.privacy, hostname)) return null;
      const { reply } = await runValidated({ generateStructured: (request) => router.review(request) }, {
        systemPrompt: buildFidelitySystemPrompt(),
        userPrompt: (errors) => buildFidelityUserPrompt(original, rewrite, checks, errors),
        schema: FidelityReplySchema,
        jsonSchema: zodToJsonSchema(FidelityReplySchema),
        maxTokens: 600,
      }, { signal });
      usedReviewer = true;
      return reply.issues.map((issue) => ({ ...issue, source: "cloud" as const }));
    },
    source: () => settings.ai.demoMode ? "demo" : usedSarvam ? "sarvam" : router?.usedProvider ?? "local",
  };
  try {
    await work(runner);
    await consumeAllowOnce(hostname, usedSarvam || usedReviewer || router?.usedProvider === "cloud");
  } catch (caught) {
    const error = toProviderError(caught);
    if (error.code !== "cancelled") {
      const { message, hint } = formatProviderError(error);
      await updateState(tabId, (state) => ({ ...state, error: { kind, code: error.code, message, hint } }));
      await onError?.(error);
    }
  } finally {
    endJob(tabId, signal, "understand");
    await updateState(tabId, (state) => (state.running?.id === id ? { ...state, running: undefined } : state));
  }
}

// ── TL;DR and glossary ────────────────────────────────────────────────────────
export async function runPageKind(tabId: number, kind: PageKind, refresh = false): Promise<void> {
  const page = await tabPage(tabId);
  if (!page) {
    await updateState(tabId, (state) => ({ ...state, error: { kind, code: "unsupported", message: "This only works on regular web pages.", hint: "Open an http(s) page and try again." } }));
    return;
  }
  await runJob(tabId, kind, page.hostname, page.url, async (runner) => {
    const parsed = PageTextSchema.safeParse(await tabMessage(tabId, { type: "GET_PAGE_TEXT" }));
    if (!parsed.success) throw new ProviderError("unknown", "Could not read this page.", "Reload the page (the extension may have been updated after it loaded).");
    const plain = stripCodeMarks(parsed.data.text);
    if (plain.length < MIN_PAGE_CHARS) throw new ProviderError("unsupported", "There is not enough article text on this page.", "Try a page with a longer article, or select text and use Explain simply.");

    const key = await cacheKey(kind, page.url, parsed.data.text);
    if (kind === "summarize") {
      const cached = refresh ? null : await readCache(key, SummaryResultSchema);
      const summary = cached ? { ...cached, cached: true } : await summarize(runner, parsed.data.text, parsed.data.title, (stage) => setStage(tabId, stage));
      if (!cached) await writeCache(key, summary);
      await updateState(tabId, (state) => ({ ...state, summary }));
      tell(tabId, { type: "SHOW_SUMMARY", summary });
    } else {
      const cached = refresh ? null : await readCache(key, GlossaryResultSchema);
      const glossary = cached ? { ...cached, cached: true, shown: true } : await glossaryOf(runner, parsed.data.text, parsed.data.title, (stage) => setStage(tabId, stage));
      if (!cached) await writeCache(key, { ...glossary, shown: false });
      // The page reports how often each term was underlined, so the panel can say where it is.
      const shown = GlossaryShownSchema.safeParse(await tabMessage(tabId, { type: "SHOW_GLOSSARY", terms: glossary.terms }));
      const counts = shown.success ? shown.data.counts : {};
      const terms = glossary.terms.map((item) => ({ ...item, count: counts[item.term.toLowerCase()] ?? 0 }));
      await updateState(tabId, (state) => ({ ...state, glossary: { ...glossary, terms } }));
    }
  });
}

function setStage(tabId: number, stage: string): Promise<UnderstandState> {
  return updateState(tabId, (state) => (state.running ? { ...state, running: { ...state.running, stage } } : state));
}

const firstSentence = (paragraph: string) => paragraph.split(/(?<=[.!?])\s+/)[0] ?? paragraph;

export async function summarize(runner: Runner, text: string, title: string, stage: (stage: string) => Promise<unknown>): Promise<SummaryResult> {
  const plain = stripCodeMarks(text);
  const notes: string[] = [];
  if (!runner.router) {
    // Demo mode: the first sentence of the first substantial paragraphs, labelled as such.
    const bullets = plain.split(/\n+/).filter((paragraph) => paragraph.split(/\s+/).length >= 12).slice(0, 4).map(firstSentence);
    return { bullets, readingMinutes: readingMinutes(plain), keyTerms: [], coverage: 1, source: "demo", cached: false, notes: ["Demo mode: first sentences of the article, not an AI summary."] };
  }
  const masked = mask(text);
  const chunks = chunkText(masked.text, textBudget(runner.settings));
  const used = chunks.slice(0, MAX_SUMMARY_CHUNKS);
  let reply;
  if (used.length === 1) {
    await stage("Summarising");
    reply = (await runComprehension(runner.router, "summarize", { text: used[0], title }, { signal: runner.signal })).reply;
  } else {
    const partials: string[] = [];
    for (const [index, chunk] of used.entries()) {
      await stage(`Summarising part ${index + 1} of ${used.length}`);
      partials.push(...(await runComprehension(runner.router, "summarize", { text: chunk, title }, { signal: runner.signal })).reply.bullets);
    }
    await stage("Combining");
    reply = (await runComprehension(runner.router, "summarize", { text: partials.map((bullet) => `- ${bullet}`).join("\n"), title, partial: true }, { signal: runner.signal })).reply;
  }
  const coverage = Math.min(1, used.reduce((total, chunk) => total + chunk.length, 0) / masked.text.length);
  if (coverage < 0.99) notes.push(`Long page: this summary covers the first ${Math.round(coverage * 100)}% of the article.`);
  const restored = reply.bullets.map((bullet) => unmask(bullet, masked.tokens).text);
  const checked = verifyBullets(restored, plain);
  if (checked.dropped > 0) notes.push(`Removed ${checked.dropped} sentence(s) that added links or emails the page does not contain.`);
  if (checked.bullets.length === 0) throw new ProviderError("invalid-plan", "The summary did not pass the safety checks.", "Try again, or switch model.");
  const keyTerms = reply.keyTerms.map((term) => unmask(term, masked.tokens).text).filter((term) => plain.toLowerCase().includes(term.toLowerCase()));
  // Reading time is counted, not asked of the model.
  return { bullets: checked.bullets, readingMinutes: readingMinutes(plain), keyTerms, coverage, source: runner.source(), cached: false, notes };
}

export async function glossaryOf(runner: Runner, text: string, title: string, stage: (stage: string) => Promise<unknown>): Promise<GlossaryResult> {
  const plain = stripCodeMarks(text);
  if (!runner.router) {
    const seen = new Set<string>();
    const terms: GlossaryTerm[] = [];
    for (const match of plain.matchAll(/\b(?:[A-Z]{2,6}s?|[a-z]{13,})\b/g)) {
      if (seen.has(match[0].toLowerCase()) || terms.length >= 8) continue;
      seen.add(match[0].toLowerCase());
      terms.push({ term: match[0], definition: "Demo mode: no AI definition. Acronyms and long words are listed as examples." });
    }
    return { terms, shown: true, source: "demo", cached: false, notes: ["Demo mode: terms picked by pattern, without definitions."] };
  }
  const masked = mask(text);
  const chunks = chunkText(masked.text, textBudget(runner.settings));
  await stage("Finding terms");
  const { reply } = await runComprehension(runner.router, "glossary", { text: chunks[0], title }, { signal: runner.signal });
  const restored = reply.terms.map(({ term, definition }) => ({ term, definition: unmask(definition, masked.tokens).text }));
  const checked = verifyGlossary(restored, plain);
  const notes: string[] = [];
  if (checked.dropped.length > 0) notes.push(`Left out ${checked.dropped.length} term(s) that are not in the page or had long definitions.`);
  if (chunks.length > 1) notes.push("Long page: terms come from the first part of the article.");
  return { terms: checked.terms, shown: true, source: runner.source(), cached: false, notes };
}

export async function hideOnPage(tabId: number, what: "summary" | "glossary"): Promise<void> {
  if (what === "summary") tell(tabId, { type: "SHOW_SUMMARY", summary: null });
  else {
    tell(tabId, { type: "SHOW_GLOSSARY", terms: null });
    await updateState(tabId, (state) => (state.glossary ? { ...state, glossary: { ...state.glossary, shown: false } } : state));
  }
}

// ── Selection: explain simply, define, translate ─────────────────────────────
export async function runSelection(tabId: number, request: UnderstandSelection): Promise<void> {
  const page = await tabPage(tabId);
  const reply = (message: Record<string, unknown>) => tell(tabId, { type: "SELECTION_RESULT", requestId: request.requestId, ...message });
  if (!page) { reply({ error: { code: "unsupported", message: "This only works on regular web pages.", hint: "" } }); return; }
  const original = stripCodeMarks(request.text).trim();
  await runJob(tabId, request.kind, page.hostname, page.url, async (runner) => {
    const variant = `${request.target ?? ""}|${request.local ? "local" : ""}`;
    const key = await cacheKey(request.kind, page.url, `${request.text}\u0000${request.context}`, variant);
    const cached = await readCache(key, SelectionResultSchema);
    const result = cached ? { ...cached, cached: true } : await selectionResult(runner, request, original, (stage) => setStage(tabId, stage));
    if (!cached) await writeCache(key, result);
    await updateState(tabId, (state) => ({ ...state, selection: result }));
    reply({ result });
  }, async (error) => {
    const { message, hint } = formatProviderError(error);
    await updateState(tabId, (state) => (state.error ? { ...state, error: { ...state.error, selection: { text: request.text.slice(0, 4400), context: request.context } } } : state));
    reply({ error: { code: error.code, message, hint } });
  });
}

export async function selectionResult(runner: Runner, request: UnderstandSelection, original: string, stage: (stage: string) => Promise<unknown>): Promise<SelectionResult> {
  const base = { kind: request.kind, original: original.slice(0, 4000) };
  const notes: string[] = [];
  const lost = (missing: number[]) => { if (missing.length > 0) notes.push(`${missing.length} piece(s) of code or link text could not be placed; see the original.`); };

  if (request.kind === "define") {
    const term = original.slice(0, 120);
    if (!runner.router) return { ...base, term: { term, definition: "Demo mode: no AI definition available." }, source: "demo", cached: false, notes };
    const context = mask(request.context || request.text);
    await stage("Defining");
    const { reply } = await runComprehension(runner.router, "define", { text: term, context: context.text }, { signal: runner.signal });
    const words = unmask(reply.terms[0]?.definition ?? "", context.tokens).text.split(/\s+/).filter(Boolean);
    if (words.length === 0) throw new ProviderError("invalid-plan", "The model gave no definition.");
    if (words.length > MAX_DEFINITION_WORDS) notes.push("Shortened to 25 words.");
    return { ...base, term: { term, definition: words.slice(0, MAX_DEFINITION_WORDS).join(" ") + (words.length > MAX_DEFINITION_WORDS ? "…" : "") }, source: runner.source(), cached: false, notes };
  }

  const masked = mask(request.text);
  if (request.kind === "simplify") {
    if (!runner.router) return { ...base, text: original.split(/(?<=[.!?])\s+/).slice(0, 2).join(" "), source: "demo", cached: false, notes: ["Demo mode: the first sentences, not an AI rewrite."] };
    await stage("Rewriting");
    const { reply } = await runComprehension(runner.router, "simplify", { text: masked.text }, { signal: runner.signal });
    const restored = unmask(reply.text, masked.tokens);
    lost(restored.missing);
    // P10: a wrong simplification is worse than none. Code checks first, then the cloud reviewer if allowed.
    const checks = checkFidelity(original, restored.text);
    let cloud: FidelityIssue[] | null = null;
    try {
      if (checks.length > 0 || runner.settings.ai.reviewPolicy === "always") {
        await stage("Checking the rewrite");
        cloud = await runner.reviewText(masked.text, reply.text, checks);
      }
    } catch (error) {
      if (toProviderError(error).code === "cancelled") throw error;
      notes.push("The cloud check of this rewrite failed; only the code check ran.");
    }
    notes.push(...fidelityNotes(checks, cloud));
    return { ...base, text: restored.text, gradeLevel: reply.gradeLevel, source: runner.source(), cached: false, notes };
  }

  // translate
  const target = request.target ?? DEFAULT_TARGET;
  if (!runner.router) throw new ProviderError("unsupported", "Demo mode does not translate.", "Turn off Demo mode and use Sarvam (hybrid or cloud mode) or the local model.");
  const pieces: string[] = [];
  const chunks = chunkText(masked.text, request.local ? LOCAL_TRANSLATE_CHUNK_CHARS : TRANSLATE_CHUNK_CHARS);
  for (const [index, chunk] of chunks.entries()) {
    await stage(chunks.length > 1 ? `Translating part ${index + 1} of ${chunks.length}` : "Translating");
    if (request.local) pieces.push((await runComprehension(runner.router, "translate", { text: chunk, target }, { signal: runner.signal })).reply.text);
    else pieces.push(await runner.translate(chunk, target));
  }
  const restored = unmask(pieces.join("\n\n"), masked.tokens);
  lost(restored.missing);
  if (request.local) notes.push("Translated by the local model: lower quality than Sarvam; check important details.");
  if (!hasDevanagari(restored.text)) notes.push("The reply does not look like Hindi; the translation may have failed.");
  return { ...base, text: restored.text, target: target as SelectionResult["target"], source: runner.source(), cached: false, notes };
}

/** Plain lines for the reader: what the meaning checks found, and who checked. */
export function fidelityNotes(checks: readonly FidelityIssue[], cloud: readonly FidelityIssue[] | null): string[] {
  const issues = [...checks, ...(cloud ?? [])];
  const lines = issues.slice(0, 5).map((issue) => `Check the original: ${issue.note}`);
  if (cloud === null) lines.push(checks.length ? "Possible meaning change found by code; the cloud reviewer was not asked (allow page text for this site to have it checked)." : "Code found no changed numbers, names or negations.");
  else if (cloud.length === 0) lines.push(checks.length ? "The cloud reviewer found no meaning errors beyond what code flagged." : "Code and the cloud reviewer found no meaning errors.");
  return lines;
}

/** Side panel retry after a consent decision, or "use the local model instead". */
export async function retryUnderstand(tabId: number, local = false): Promise<string | null> {
  const state = await readUnderstand(tabId);
  const error = state?.error;
  if (!error) return "Nothing to retry.";
  if (error.kind === "summarize" || error.kind === "glossary") { void runPageKind(tabId, error.kind); return null; }
  if (!error.selection) return "Select the text again and choose an action.";
  void runSelection(tabId, { type: "UNDERSTAND_SELECTION", requestId: `retry-${Date.now()}`, kind: error.kind, text: error.selection.text, context: error.selection.context, target: error.kind === "translate" ? DEFAULT_TARGET : undefined, local });
  return null;
}
