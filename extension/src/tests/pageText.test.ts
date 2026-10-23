// @vitest-environment jsdom
// Main-content extraction and glossary ranges on the real P08 fixtures.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { extractPageText, selectionText } from "../content/pageText";
import { findTermRanges } from "../content/glossary";
import { mask, stripCodeMarks, unmask } from "../shared/textMask";

const fixture = (name: string) => readFileSync(join(__dirname, "../../../fixtures", name), "utf8");
function load(name: string): void {
  document.documentElement.innerHTML = new DOMParser().parseFromString(fixture(name), "text/html").documentElement.innerHTML;
}

beforeAll(() => {
  globalThis.CSS = { escape: (value: string) => value.replace(/([^\w-])/g, "\\$1") } as typeof CSS;
});

describe("extractPageText", () => {
  it("reads only the main content: no site navigation, sidebar or footer", () => {
    load("long-article.html");
    const { text } = extractPageText(document.querySelector("main")!);
    expect(text).toContain("How central banks cool inflation");
    expect(text).toContain("monetary policy transmission");
    expect(text).not.toContain("The Ledger Review");
    expect(text).not.toContain("Five charts on household debt");
    expect(text.split("\n\n").length).toBeGreaterThan(15);
  });

  it("skips code blocks, marks inline code, and masks links and identifiers before anything is sent", () => {
    load("bilingual.html");
    const { text, skippedCode } = extractPageText(document.querySelector("main")!);
    expect(skippedCode).toBe(1);
    expect(text).not.toContain("npx monsoon-widget init");
    const masked = mask(text);
    expect(masked.text).not.toMatch(/https?:\/\/|www\.|@monsoon|@evil|user_settings|API_KEY|loadForecast|show_wind|showHumidity|weatherPanel|node --version/);
    expect(unmask(masked.text, masked.tokens).text).toBe(stripCodeMarks(text));
  });

  it("gives a selection's text and its paragraph as context", () => {
    load("bilingual.html");
    const paragraph = Array.from(document.querySelectorAll("p")).find((element) => element.textContent?.includes("loadForecast"))!;
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    const { text, context } = selectionText(range);
    expect(stripCodeMarks(text)).toContain("loadForecast()");
    expect(mask(text).tokens).toContain("loadForecast()");
    expect(context).toBe(text);
  });
});

describe("findTermRanges", () => {
  it("finds whole-word, case-insensitive matches outside code, longest term first, without overlaps", () => {
    document.body.innerHTML = `<main><p>The Yield curve inverted. A yield curve is a chart; yields rose.</p><p>Use <code>yield curve</code> in code.</p><p>Curve fitting.</p></main>`;
    const ranges = findTermRanges(document.querySelector("main")!, ["curve", "yield curve"]);
    expect(ranges.map((item) => `${item.term}:${item.range.toString()}`)).toEqual(["yield curve:Yield curve", "yield curve:yield curve", "curve:Curve"]);
  });
});
