// @vitest-environment jsdom
// P11 dyslexia lens: English syllable counting, the thresholds, every planted
// problem on fixtures/dyslexia-hard.html, nothing extra when the lens is off,
// and the score with the new category (caps still add up to 100, monotonic).

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { inspectPage } from "../content/inspector";
import { isGlare, isLiteralCaps, longWordSeverity, sentenceLengths, sentenceSeverity, styledShareSeverity } from "../content/inspectorRules";
import { CATEGORY_CAP, FINDING_TYPES, LEVELS, readabilityScore, type Finding } from "../shared/inspector";
import { hyphenate, longWordShare, syllableCount, wordsOf } from "../shared/syllables";

const FIXTURE = readFileSync(resolve(__dirname, "../../../fixtures/dyslexia-hard.html"), "utf8");

afterEach(() => { vi.restoreAllMocks(); });

describe("syllables (English hyphenation patterns)", () => {
  it("counts known words", () => {
    const known: Record<string, number> = {
      cat: 1, the: 1, fire: 1, table: 2, people: 2, reading: 2, simple: 2, create: 2, computer: 3, beautiful: 3, every: 3, banana: 3,
      information: 4, comprehension: 4, understanding: 4, temperature: 4, necessary: 4, university: 5, communication: 5, organization: 5,
      responsibility: 6, accessibility: 6, incomprehensibility: 8,
    };
    for (const [word, count] of Object.entries(known)) expect(syllableCount(word), word).toBe(count);
    expect(syllableCount("Information")).toBe(4);
    expect(syllableCount("1234")).toBe(0);
  });

  it("splits at the patterns' break points and never leaves a piece without a vowel", () => {
    expect(hyphenate("information")).toEqual(["in", "for", "ma", "tion"]);
    expect(hyphenate("presentation").every((piece) => /[aeiouy]/.test(piece))).toBe(true);
  });

  it("measures the share of long words", () => {
    const words = wordsOf("The cat sat on the mat with comprehensive documentation.");
    expect(words).toHaveLength(9);
    expect(longWordShare(words)).toBeCloseTo(2 / 9);
  });
});

describe("lens thresholds", () => {
  it("rates styled shares, sentence length and long words", () => {
    expect(styledShareSeverity(0.05)).toBeNull();
    expect(styledShareSeverity(0.2)).toBe("low");
    expect(styledShareSeverity(0.3)).toBe("medium");
    expect(styledShareSeverity(0.6)).toBe("high");
    expect(sentenceSeverity(18)).toBeNull();
    expect(sentenceSeverity(24)).toBe("medium");
    expect(sentenceSeverity(32)).toBe("high");
    expect(longWordSeverity(0.04)).toBeNull();
    expect(longWordSeverity(0.12)).toBe("medium");
  });

  it("splits sentences, spots glare and typed capitals", () => {
    expect(sentenceLengths("One two three. Four five! Is this six? Yes.")).toEqual([3, 2, 3, 1]);
    expect(sentenceLengths("Version 2.5 ships today. It works.")).toEqual([4, 2]);
    expect(isGlare({ r: 255, g: 255, b: 255 }, { r: 0, g: 0, b: 0 })).toBe(true);
    expect(isGlare({ r: 253, g: 246, b: 227 }, { r: 0, g: 0, b: 0 })).toBe(false);
    expect(isLiteralCaps("PLEASE DO NOT DRINK TAP WATER TODAY")).toBe(true);
    expect(isLiteralCaps("Please do not drink tap water today")).toBe(false);
    expect(isLiteralCaps("NASA and the ESA")).toBe(false);
  });
});

function loadFixture(): void {
  document.open();
  document.write(FIXTURE);
  document.close();
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, top: 0, left: 0, right: 700, bottom: 40, width: 700, height: 40, toJSON: () => ({}) } as DOMRect);
}

const options = (lens: boolean, current: Record<string, string | number | boolean> = {}) => ({
  region: document.querySelector("main")!,
  current: { fontSize: 16, lineHeight: 1.5, maxContentWidth: 800, theme: "light", backgroundTint: "none", noItalics: false, unjustify: false, noAllCaps: false, ...current },
  smartColours: false,
  testFocus: false,
  lens,
});

describe("dyslexia lens on dyslexia-hard.html", () => {
  it("finds every planted problem, with a fix where a setting can help", async () => {
    loadFixture();
    const report = await inspectPage(document, options(true));
    expect(report.lens).toBe(true);
    const types = new Set(report.findings.map((finding) => finding.type));
    for (const type of ["justified-text", "italic-body", "all-caps-text", "long-sentences", "long-words", "glare", "huge-block"] as const) expect(types, type).toContain(type);
    const fixOf = (type: Finding["type"]) => report.findings.find((finding) => finding.type === type && finding.suggestedFix)?.suggestedFix?.changes;
    expect(fixOf("justified-text")).toEqual({ unjustify: true });
    expect(fixOf("italic-body")).toEqual({ noItalics: true });
    expect(fixOf("all-caps-text")).toEqual({ noAllCaps: true });
    expect(fixOf("glare")).toEqual({ backgroundTint: "cream" });
    // Text typed in capitals gets advice only: the page's text is never rewritten.
    const typed = report.findings.find((finding) => finding.type === "all-caps-text" && finding.evidence.styled === 0)!;
    expect(typed.suggestedFix).toBeUndefined();
    expect(typed.advice).toMatch(/never rewritten/);
    // Code is not body text: its italic capitals do not count.
    expect(report.findings.every((finding) => !finding.label?.startsWith("code"))).toBe(true);
  });

  it("adds nothing when the lens is off", async () => {
    loadFixture();
    const report = await inspectPage(document, options(false));
    const lensTypes = new Set<string>(["justified-text", "italic-body", "all-caps-text", "long-sentences", "long-words", "glare"]);
    expect(report.findings.filter((finding) => lensTypes.has(finding.type))).toEqual([]);
    expect(report.lens).toBe(false);
  });

  it("offers no fix for a setting that is already on", async () => {
    loadFixture();
    const report = await inspectPage(document, options(true, { unjustify: true, backgroundTint: "cream" }));
    expect(report.findings.find((finding) => finding.type === "justified-text")?.suggestedFix).toBeUndefined();
    expect(report.findings.find((finding) => finding.type === "glare")?.suggestedFix).toBeUndefined();
  });
});

describe("score with the dyslexia category", () => {
  it("caps still add up to 100 and the lens has its own cap", () => {
    expect(Object.values(CATEGORY_CAP).reduce((sum, cap) => sum + cap, 0)).toBe(100);
    const many = readabilityScore(Array.from({ length: 10 }, (_, index) => ({ type: FINDING_TYPES.includes("glare") ? (["glare", "italic-body", "justified-text"] as const)[index % 3] : "glare", severity: "high" as const, confidence: "high" as const })));
    expect(many.value).toBe(100 - CATEGORY_CAP.dyslexia);
  });

  it("stays monotonic: fixing a lens finding never lowers the score", () => {
    const list = (["justified-text", "italic-body", "all-caps-text", "long-sentences", "long-words", "glare", "small-text", "low-contrast"] as const)
      .map((type) => ({ type, severity: "medium" as const, confidence: "high" as const }));
    const base = readabilityScore(list).value;
    list.forEach((_, index) => {
      expect(readabilityScore(list.filter((__, other) => other !== index)).value).toBeGreaterThanOrEqual(base);
      for (const lower of LEVELS.slice(LEVELS.indexOf(list[index].severity))) {
        expect(readabilityScore(list.map((item, other) => (other === index ? { ...item, severity: lower } : item))).value).toBeGreaterThanOrEqual(base);
      }
    });
  });
});
