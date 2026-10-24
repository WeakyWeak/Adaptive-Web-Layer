// P11 dyslexia reading view: short paragraphs enforced by code, the draft →
// code check → cloud review pipeline (review only when allowed), masking of
// code and links, and the Demo-mode split.

import { describe, expect, it, vi } from "vitest";
import { buildReadingView, shortParagraphs } from "../background/readingView";
import type { Runner } from "../background/comprehension";
import { ReadingViewResultSchema } from "../shared/comprehension";
import { defaultSettings } from "../shared/settings";
import { CODE_END, CODE_START } from "../shared/textMask";
import type { StructuredRequest } from "../shared/llmProvider";

const ARTICLE = [
  "The water board will close the north pipe on 12 May for repairs. Homes in districts 3 and 4 will have no water for six hours.",
  `Do not drink tap water for 24 hours afterwards. Updates are posted at https://example.org/water and in the ${CODE_START}status.json${CODE_END} feed.`,
].join("\n\n");

/** A fake local model: a faithful rewrite (or a careless one), and a 3-bullet summary. */
function fakeModel(careless = false) {
  const calls: string[] = [];
  return {
    calls,
    generateStructured: vi.fn(async (request: StructuredRequest) => {
      if (request.systemPrompt.includes("reading view")) {
        calls.push("draft");
        const text = request.userPrompt.split("<page_data>\n")[1].split("\n</page_data>")[0];
        const body = careless ? text.replace("six hours", "two hours").replace("Do not drink", "Drink") : text;
        const [first, second] = body.split("\n\n");
        return { blocks: [
          { kind: "heading", text: "Water repairs", items: [] },
          { kind: "paragraph", text: `${first} More detail here. Then more. Then the last.`, items: [] },
          { kind: "list", text: "Remember:", items: [second] },
        ] };
      }
      calls.push("summary");
      return { bullets: ["The north pipe closes on 12 May.", "Districts 3 and 4 lose water for six hours.", "Do not drink tap water for 24 hours."], readingMinutes: 1, keyTerms: [] };
    }),
  };
}

function runner(model: ReturnType<typeof fakeModel>, reviewText: Runner["reviewText"]): Runner {
  return { settings: defaultSettings(), router: model, signal: new AbortController().signal, translate: vi.fn(), reviewText, source: () => "local" };
}

describe("short paragraphs", () => {
  it("splits paragraphs over 3 sentences and drops empty blocks", () => {
    const blocks = shortParagraphs([
      { kind: "paragraph", text: "One. Two. Three. Four. Five.", items: [] },
      { kind: "list", text: "", items: [" a ", ""] },
      { kind: "heading", text: "  ", items: [] },
    ]);
    expect(blocks).toEqual([
      { kind: "paragraph", text: "One. Two. Three.", items: [] },
      { kind: "paragraph", text: "Four. Five.", items: [] },
      { kind: "list", text: "", items: ["a"] },
    ]);
  });
});

describe("reading view pipeline", () => {
  it("drafts, checks with code, has the cloud review, and keeps code and links exact", async () => {
    const model = fakeModel();
    const reviewText = vi.fn(async () => []);
    const view = await buildReadingView({ runner: runner(model, reviewText), text: ARTICLE, title: "Water", stage: async () => undefined });
    expect(ReadingViewResultSchema.safeParse(view).success).toBe(true);
    expect(model.calls).toEqual(["draft", "summary"]);
    // The masked text reached the model; the view has the originals back.
    const draftPrompt = model.generateStructured.mock.calls[0][0].userPrompt;
    expect(draftPrompt).not.toContain("https://example.org/water");
    expect(draftPrompt).not.toContain("status.json");
    const all = JSON.stringify(view.blocks);
    expect(all).toContain("https://example.org/water");
    expect(all).toContain("status.json");
    // The paragraph the model ran on is split to at most 3 sentences.
    expect(view.blocks.filter((block) => block.kind === "paragraph").every((block) => block.text.split(/(?<=\.)\s+/).length <= 3)).toBe(true);
    expect(view.summary).toHaveLength(3);
    expect(view.checks).toMatchObject({ flagged: 0, parts: 1, review: "reviewed", reviewedParts: 1, issues: 0 });
    expect(reviewText).toHaveBeenCalledTimes(1);
    expect(view.notes.join(" ")).toMatch(/Code and the cloud reviewer found no meaning errors/);
  });

  it("flags changed numbers and flipped negations, and says the cloud was not asked without page-text consent", async () => {
    const view = await buildReadingView({ runner: runner(fakeModel(true), async () => null), text: ARTICLE, title: "Water", stage: async () => undefined });
    expect(view.checks).toMatchObject({ flagged: 1, review: "not-allowed", reviewedParts: 0 });
    const notes = view.notes.join(" ");
    expect(notes).toMatch(/Check the original/);
    expect(notes).toMatch(/allow page text for this site/);
  });

  it("keeps the view when only the cloud review fails, and says so", async () => {
    const view = await buildReadingView({ runner: runner(fakeModel(), async () => { throw new Error("proxy down"); }), text: ARTICLE, title: "Water", stage: async () => undefined });
    expect(view.checks.review).toBe("failed");
    expect(view.notes.join(" ")).toMatch(/cloud check of the reading view failed/);
    expect(view.blocks.length).toBeGreaterThan(0);
  });

  it("Demo mode splits the text into short paragraphs by code, labelled", async () => {
    const demo: Runner = { ...runner(fakeModel(), async () => null), router: null, source: () => "demo" };
    const view = await buildReadingView({ runner: demo, text: ARTICLE, title: "Water", stage: async () => undefined });
    expect(view.source).toBe("demo");
    expect(view.notes[0]).toMatch(/not rewritten by AI/);
    expect(view.blocks.every((block) => block.kind === "paragraph")).toBe(true);
  });
});
