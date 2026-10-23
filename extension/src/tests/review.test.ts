// P10 supervised fix, pure parts: folding a cloud review into a local draft
// (through the same validators as a plan), regressions, when to review,
// the reviewer's schema, and the meaning checks for simplified text.

import { describe, expect, it } from "vitest";
import { fidelityNotes } from "../background/comprehension";
import { layoutMarks } from "../background/screenshot";
import { buildReviewUserPrompt } from "../background/reviewPrompt";
import { CLEAN_PAGE_REQUEST, validateElements, type SnapshotBlock } from "../shared/elementPlan";
import type { DomSnapshot } from "../shared/plan";
import {
  applyReview,
  checkFidelity,
  chunksToReview,
  draftIsUnsure,
  draftItems,
  draftLedger,
  regressions,
  ReviewReplySchema,
  reviewJsonSchema,
  type Measures,
  type ReviewReply,
} from "../shared/review";
import { defaultSettings } from "../shared/settings";
import { currentAiValues } from "../shared/sitePatch";

const block = (id: string, extra: Partial<SnapshotBlock> = {}): SnapshotBlock => ({
  id, tag: "div", hints: "", text: "", box: [0, 0, 100, 10], fixed: false, area: 3, linkDensity: 0, main: false, inMain: false, children: 0, ad: false, ...extra,
});

// Mirrors fixtures/obfuscated-clutter.html: random class names everywhere.
const snapshot: DomSnapshot = {
  url: "http://localhost:4173/obfuscated-clutter.html", title: "Library", contentRegion: "main", headings: [], landmarks: [], textBlocks: [],
  imageCnt: 0, tableCnt: 0, codeBlockCnt: 0, tokenEstimate: 100,
  blocks: [
    block("s1", { hints: "x9a3f", text: "We value your privacy. We and our 214 partners" }),
    block("s2", { hints: "q7lk", text: "Riverside Library Catalogue Events", protect: "navigation" }),
    block("s3", { hints: "mm42", text: "FLASH SALE: 60% off" }),
    block("s4", { hints: "c1z", text: "On this page What changes Why", linkDensity: 0.9 }),
    block("s5", { tag: "main", main: true, area: 45 }),
    block("s6", { hints: "k2v", text: "Get the weekly digest", inMain: true, within: "s5" }),
    block("s7", { hints: "r8t", text: "You may also like", linkDensity: 0.8, area: 18 }),
  ],
};
const current = currentAiValues(defaultSettings(), "localhost");
const reply = (patch: Partial<ReviewReply> = {}): ReviewReply => ({ verdict: "revise", drop: [], add: { changes: {}, elements: { hide: [], dim: [], highlight: [] } }, missedRegions: [], notes: "", ...patch });

/** The local draft: hides the consent banner, the navigation (needs a tick) and the table of contents (a mistake). */
function draft() {
  const review = validateElements({ hide: ["s1", "s2", "s4"], dim: [], highlight: [] }, snapshot);
  const changes = { fontSize: 18 };
  return { changes, items: review.items, ledger: draftLedger(changes, review.items, "local") };
}

describe("applyReview", () => {
  it("drops what the reviewer drops and adds what it adds, with reasons and sources", () => {
    const { changes, items, ledger } = draft();
    const outcome = applyReview({
      request: CLEAN_PAGE_REQUEST, snapshot, current, changes, items, ledger,
      reply: reply({ drop: [{ ref: "s4", reason: "This is the table of contents." }], add: { changes: {}, elements: { hide: ["s3", "s7"], dim: [], highlight: [] } } }),
    });
    expect(outcome.items.map((item) => item.id).sort()).toEqual(["s1", "s2", "s3", "s7"]);
    expect(outcome.ledger.find((entry) => entry.ref === "s4")).toMatchObject({ status: "dropped", source: "cloud", reason: "This is the table of contents." });
    expect(outcome.ledger.filter((entry) => entry.status === "added").map((entry) => entry.ref)).toEqual(["s3", "s7"]);
    expect(outcome.ledger.find((entry) => entry.ref === "s1")).toMatchObject({ status: "kept", source: "local" });
    // A protected draft item keeps its "needs your tick" state.
    expect(outcome.items.find((item) => item.id === "s2")).toMatchObject({ protect: "navigation", enabled: false });
  });

  it("runs the reviewer's additions through the same validator: never the main content", () => {
    const { changes, items, ledger } = draft();
    const outcome = applyReview({ request: CLEAN_PAGE_REQUEST, snapshot, current, changes, items, ledger, reply: reply({ add: { changes: {}, elements: { hide: ["s5", "nope"], dim: [], highlight: [] } } }) });
    expect(outcome.items.some((item) => item.id === "s5")).toBe(false);
    expect(outcome.rejected.map((item) => item.reason)).toEqual(expect.arrayContaining(["This is the main content, or contains it.", "Not an element on this page."]));
  });

  it("keeps settings in range and the colour rule, and marks a replaced setting", () => {
    const { changes, items, ledger } = draft();
    const outcome = applyReview({
      request: "make the text bigger", snapshot, current, changes, items, ledger,
      reply: reply({ add: { changes: { fontSize: "22", lineHeight: 9, theme: "dark", madeUp: 1 }, elements: { hide: [], dim: [], highlight: [] } } }),
    });
    expect(outcome.changes).toEqual({ fontSize: 22 });
    expect(outcome.ledger.find((entry) => entry.ref === "fontSize" && entry.status === "dropped")?.reason).toMatch(/Replaced by the reviewer/);
    expect(outcome.ledger.find((entry) => entry.ref === "fontSize" && entry.status === "added")).toBeTruthy();
    expect(outcome.notes.join(" ")).toMatch(/lineHeight.*out of range|madeUp/);
    expect(outcome.notes.join(" ")).toMatch(/Kept the site's colours/);
  });

  it("ignores element additions when the request is not about page parts (injection defence)", () => {
    const outcome = applyReview({ request: "make the text bigger", snapshot, current, changes: { fontSize: 20 }, items: [], ledger: draftLedger({ fontSize: 20 }, [], "local"), reply: reply({ add: { changes: {}, elements: { hide: ["s2", "s4"], dim: [], highlight: [] } } }) });
    expect(outcome.items).toEqual([]);
    expect(outcome.notes.join(" ")).toMatch(/didn't ask to hide/);
  });

  it("reports corrections that name nothing in the draft", () => {
    const { changes, items, ledger } = draft();
    const outcome = applyReview({ request: CLEAN_PAGE_REQUEST, snapshot, current, changes, items, ledger, reply: reply({ drop: [{ ref: "s99", reason: "?" }] }) });
    expect(outcome.notes).toContain("Ignored 1 reviewer correction(s) that named nothing in the draft.");
    expect(outcome.items).toHaveLength(3);
  });

  it("parses a reviewer reply and offers only real refs and ids in its schema", () => {
    expect(ReviewReplySchema.safeParse(reply()).success).toBe(true);
    const schema = reviewJsonSchema(["fontSize", "s1"], ["s1", "s2"]) as { required: string[]; properties: Record<string, { items?: { properties?: Record<string, { enum?: string[] }> } }> };
    expect(schema.required).toEqual(["verdict", "drop", "add", "missedRegions", "notes"]);
    expect(schema.properties.drop.items?.properties?.ref.enum).toEqual(["fontSize", "s1"]);
  });
});

describe("what the reviewer sees", () => {
  it("lists draft items with where they are, measurements, and blocks as untrusted data", () => {
    const { changes, items } = draft();
    const prompt = buildReviewUserPrompt({ request: CLEAN_PAGE_REQUEST, current, draft: draftItems(changes, items), snapshot: { ...snapshot, blocks: [...snapshot.blocks] }, screenshots: false });
    expect(prompt).toContain("- fontSize [setting]: Text size → 18px");
    expect(prompt).toContain("- s2 [hide]");
    expect(prompt).toMatch(/s2 \[hide\][^\n]*· navigation/);
    expect(prompt).toMatch(/<page_data>[\s\S]*s6 <div>[^\n]*in the article[\s\S]*<\/page_data>/);
    expect(prompt).toContain("SCREENSHOTS: none");
  });
});

describe("regressions", () => {
  const before: Measures = { score: 70, mainText: 1000, hiddenText: 0, protectedVisible: 3, overflow: 0, overlap: 0, clipped: 0 };
  it("finds nothing when the page is not worse", () => {
    expect(regressions(before, { ...before, score: 80 })).toEqual([]);
  });
  it("flags a lower score, lost text, new overflow and a vanished protected element", () => {
    const reasons = regressions(before, { score: 65, mainText: 900, hiddenText: 0, protectedVisible: 2, overflow: 1, overlap: 0, clipped: 0 });
    expect(reasons).toHaveLength(4);
    expect(reasons[0]).toMatch(/fell from 70 to 65/);
  });
  it("does not count text hidden on purpose, up to a quarter of the article", () => {
    expect(regressions(before, { ...before, mainText: 850, hiddenText: 150 })).toEqual([]);
    expect(regressions(before, { ...before, mainText: 600, hiddenText: 400 })).toEqual([expect.stringMatching(/hide 40% of the main text/)]);
  });
  it("allows protected elements the user agreed to hide", () => {
    expect(regressions(before, { ...before, protectedVisible: 2 }, 1)).toEqual([]);
  });
});

describe("draftIsUnsure", () => {
  const measures = (score: number): Measures => ({ score, mainText: 1, hiddenText: 0, protectedVisible: 0, overflow: 0, overlap: 0, clipped: 0 });
  it("is unsure on low confidence, no improvement, or many refused items", () => {
    expect(draftIsUnsure({ confidence: 0.4, requested: 0, refused: 0 })).toBe(true);
    expect(draftIsUnsure({ confidence: 0.9, before: measures(70), draft: measures(70), requested: 0, refused: 0 })).toBe(true);
    expect(draftIsUnsure({ confidence: 0.9, requested: 4, refused: 2 })).toBe(true);
    expect(draftIsUnsure({ confidence: 0.9, before: measures(60), draft: measures(80), requested: 4, refused: 1 })).toBe(false);
  });
});

describe("checkFidelity (simplified text)", () => {
  const original = "Tankers will stand at the ward offices from nine until five on each flushing day. Bring at most 40 litres per household. Do not leave books on the steps.";
  it("passes a faithful rewrite", () => {
    expect(checkFidelity(original, "Water tankers wait at ward offices from nine to five on flushing days. Bring no more than 40 litres per home. Do not leave books on the steps.")).toEqual([]);
  });
  it("catches a dropped number", () => {
    expect(checkFidelity(original, "Tankers wait at ward offices on flushing days. Bring your own containers. Do not leave books on the steps.")).toEqual([expect.objectContaining({ problem: "dropped-fact", note: expect.stringContaining("40") })]);
  });
  it("catches a changed number", () => {
    expect(checkFidelity(original, "Tankers wait from nine until five. Bring at most 20 litres. Do not leave books on the steps.")[0]).toMatchObject({ problem: "number-changed" });
  });
  it("catches a flipped negation", () => {
    expect(checkFidelity("You must not drink the water before 6 pm.", "You must drink the water before 6 pm.")).toEqual([expect.objectContaining({ problem: "negation-flipped" })]);
  });
  it("accepts a plural turned singular", () => {
    expect(checkFidelity("The rooms are full on Tuesdays and Thursdays.", "The rooms are full on Tuesday and Thursday evenings.")).toEqual([]);
  });
  it("catches a dropped name and accepts number words", () => {
    expect(checkFidelity("Ask Priya Sharma at the desk for 2 forms.", "Ask at the desk for two forms.").map((issue) => issue.problem)).toEqual(["dropped-fact"]);
  });
});

describe("fidelityNotes (what the reader is told)", () => {
  const issue = checkFidelity("Bring at most 40 litres.", "Bring some water.");
  it("asks the reader to check the original, and says who checked", () => {
    expect(fidelityNotes(issue, null)).toEqual([expect.stringMatching(/^Check the original: Missing number/), expect.stringMatching(/cloud reviewer was not asked.*allow page text/)]);
    expect(fidelityNotes([], [])).toEqual(["Code and the cloud reviewer found no meaning errors."]);
    expect(fidelityNotes([], [{ problem: "negation-flipped", note: "must became must not", source: "cloud" }])[0]).toBe("Check the original: must became must not");
  });
});

describe("chunksToReview (Minions-style sampling)", () => {
  it("reviews every flagged chunk plus an even sample", () => {
    expect(chunksToReview(12, [5], 3)).toEqual([2, 5, 6, 10]);
    expect(chunksToReview(2, [], 3)).toEqual([0, 1]);
    expect(chunksToReview(5, [9, -1], 1)).toEqual([2]);
  });
});

describe("Set-of-Mark layout", () => {
  it("scales boxes to the image, colours draft items red, and keeps labels inside the image", () => {
    const marks = layoutMarks([{ id: "s1", x: 0, y: 0, w: 1280, h: 80 }, { id: "s12", x: 1200, y: 780, w: 80, h: 20 }], 0.5, 640, 400, new Set(["s1"]));
    expect(marks[0]).toMatchObject({ x: 0, y: 0, w: 640, h: 40, colour: "#d62828" });
    expect(marks[1]).toMatchObject({ x: 600, y: 390, colour: "#1d4ed8" });
    expect(marks[1].label.x + marks[1].label.w).toBeLessThanOrEqual(640);
    expect(marks[1].label.y + marks[1].label.h).toBeLessThanOrEqual(400);
  });
});
