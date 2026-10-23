// Inspector, pure parts: the readability score (formula, caps, monotonic,
// stable), merging fixes, the thresholds, and what a model may see.

import { describe, expect, it } from "vitest";
import { headingIssues, lineLengthIssue, contrastSeverity, smallTextSeverity, median, lineHeightSeverity, stickySeverity } from "../content/inspectorRules";
import { buildExplainUserPrompt } from "../background/inspect";
import {
  CATEGORY_CAP,
  checkInterpretation,
  FINDING_TYPES,
  findingsForModel,
  LEVELS,
  mergeFixes,
  rankFindings,
  readabilityScore,
  type Finding,
  type Level,
} from "../shared/inspector";

const finding = (type: Finding["type"], severity: Level = "medium", confidence: Level = "high", extra: Partial<Finding> = {}): Finding => ({
  id: `${type}-1`, type, severity, confidence, title: type, detail: "measured", evidence: { value: 1 }, ...extra,
});

describe("readabilityScore", () => {
  it("is 100 with no findings and lists no contributors", () => {
    expect(readabilityScore([])).toEqual({ value: 100, contributors: [] });
  });

  it("follows the documented formula: severity × confidence, capped per category", () => {
    // contrast: 10 × 1 + 5 × 0.6 = 13; headings: 2 × 0.25 = 0.5 → 100 − 13.5 = 86.5 → 87
    const score = readabilityScore([finding("low-contrast", "high"), finding("low-contrast", "medium", "medium"), finding("no-h1", "low", "low")]);
    expect(score.value).toBe(87);
    expect(score.contributors[0]).toMatchObject({ category: "contrast", penalty: 13, findings: 2 });
    // Many findings in one category never take more than its cap.
    const many = readabilityScore(Array.from({ length: 20 }, () => finding("low-contrast", "high")));
    expect(many.value).toBe(100 - CATEGORY_CAP.contrast);
  });

  it("can reach 0 only when every category is at its cap", () => {
    const all = FINDING_TYPES.flatMap((type) => Array.from({ length: 4 }, () => finding(type, "high")));
    expect(readabilityScore(all).value).toBe(0);
  });

  it("puts the three biggest contributors first", () => {
    const score = readabilityScore([finding("no-h1", "low"), finding("small-text", "high"), finding("low-contrast", "high"), finding("low-contrast", "high"), finding("overlap", "medium")]);
    expect(score.contributors.slice(0, 3).map((item) => item.category)).toEqual(["contrast", "text-size", "layout"]);
  });

  it("is stable: same findings in any order give the same score", () => {
    const list = [finding("small-text", "high"), finding("overlap", "medium", "medium"), finding("empty-heading", "medium"), finding("low-contrast", "high", "low")];
    const first = readabilityScore(list);
    expect(readabilityScore([...list].reverse())).toEqual(first);
    expect(readabilityScore(list)).toEqual(first);
  });

  it("is monotonic: removing or downgrading any finding never lowers the score", () => {
    const list = [
      finding("small-text", "high"), finding("low-contrast", "high"), finding("low-contrast", "medium", "low"), finding("tight-line-height", "medium"),
      finding("long-lines", "high"), finding("skipped-heading", "medium"), finding("sticky-cover", "high"), finding("focus-indicator", "high", "medium"),
      finding("low-contrast", "high"), finding("low-contrast", "high"), finding("link-distinction", "medium"),
    ];
    const base = readabilityScore(list).value;
    list.forEach((_, index) => {
      expect(readabilityScore(list.filter((__, other) => other !== index)).value).toBeGreaterThanOrEqual(base);
      for (const lower of LEVELS.slice(LEVELS.indexOf(list[index].severity))) {
        const downgraded = list.map((item, other) => (other === index ? { ...item, severity: lower } : item));
        expect(readabilityScore(downgraded).value).toBeGreaterThanOrEqual(base);
      }
    });
  });
});

describe("mergeFixes", () => {
  it("keeps the strongest value per setting and every hide", () => {
    const merged = mergeFixes([
      { changes: { fontSize: 18, maxContentWidth: 760 }, hide: ["s1"], description: "a" },
      { changes: { fontSize: 20, maxContentWidth: 720, underlineLinks: true }, hide: ["s1", "s2"], description: "b" },
      { changes: { underlineLinks: false }, hide: [], description: "a" },
    ]);
    expect(merged.changes).toEqual({ fontSize: 20, maxContentWidth: 720, underlineLinks: true });
    expect(merged.hide).toEqual(["s1", "s2"]);
    expect(merged.descriptions).toEqual(["a", "b"]);
  });
});

describe("inspector thresholds", () => {
  it("reads the heading outline", () => {
    expect(headingIssues([])).toEqual([expect.objectContaining({ type: "no-h1" })]);
    expect(headingIssues([{ level: 2, empty: false }, { level: 3, empty: false }]).map((issue) => issue.type)).toEqual(["no-h1"]);
    const issues = headingIssues([{ level: 1, empty: false }, { level: 1, empty: false }, { level: 2, empty: false }, { level: 4, empty: false }, { level: 3, empty: true }, { level: 5, empty: false }]);
    expect(issues.map((issue) => issue.type)).toEqual(["multiple-h1", "skipped-heading", "empty-heading"]);
    expect(issues.find((issue) => issue.type === "skipped-heading")).toMatchObject({ indexes: [3, 5], detail: expect.stringContaining("h2 → h4") });
    expect(issues.find((issue) => issue.type === "empty-heading")?.indexes).toEqual([4]);
    // Going back up any number of levels is fine.
    expect(headingIssues([{ level: 1, empty: false }, { level: 2, empty: false }, { level: 3, empty: false }, { level: 2, empty: false }])).toEqual([]);
  });

  it("judges line length against the window", () => {
    expect(lineLengthIssue(141, 1280)).toEqual({ type: "long-lines", severity: "high" });
    expect(lineLengthIssue(110, 1280)).toEqual({ type: "long-lines", severity: "medium" });
    expect(lineLengthIssue(70, 1280)).toBeNull();
    expect(lineLengthIssue(30, 1280)).toEqual({ type: "narrow-column", severity: "medium" });
    expect(lineLengthIssue(20, 1280)?.severity).toBe("high");
    expect(lineLengthIssue(30, 400)).toBeNull(); // phone-sized window
  });

  it("grades contrast, text size, line height and sticky bars", () => {
    expect(contrastSeverity(4.6, 4.5)).toBeNull();
    expect(contrastSeverity(3.5, 4.5)).toBe("medium");
    expect(contrastSeverity(2.3, 4.5)).toBe("high");
    expect(contrastSeverity(2.5, 3)).toBe("medium");
    expect(smallTextSeverity(14, 0.5)).toBeNull();
    expect(smallTextSeverity(11, 0.09)).toBe("high");
    expect(smallTextSeverity(13, 0.1)).toBe("medium");
    expect(smallTextSeverity(13, 0.01)).toBe("low");
    expect(lineHeightSeverity(1.5)).toBeNull();
    expect(lineHeightSeverity(1.2)).toBe("medium");
    expect(lineHeightSeverity(1.05)).toBe("high");
    expect(stickySeverity(0.1)).toBeNull();
    expect(stickySeverity(0.14)).toBe("medium");
    expect(stickySeverity(0.3)).toBe("high");
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });
});

describe("what a model may see", () => {
  const findings = [
    finding("low-contrast", "high", "high", { id: "low-contrast-1", label: "p “Call 555-0100 to reset your PIN”", elementRef: "s9", evidence: { ratio: 2.3, required: 4.5 } }),
    finding("empty-heading", "medium", "high", { id: "empty-heading-1" }),
  ];

  it("sends measurements only: no labels, element ids or page text", () => {
    const prompt = buildExplainUserPrompt({ findings, scanned: 10, capped: false, durationMs: 5, score: readabilityScore(findings), measuredAt: 0 });
    expect(prompt).toContain("low-contrast-1");
    expect(prompt).toContain("2.3");
    expect(prompt).not.toMatch(/555|PIN|s9|label/);
    expect(findingsForModel(findings)[0]).toEqual({ id: "low-contrast-1", type: "low-contrast", severity: "high", confidence: "high", evidence: { ratio: 2.3, required: 4.5 }, fixable: false });
  });

  it("drops priorities that name no finding, or repeat one", () => {
    const checked = checkInterpretation({ summary: "s", priorities: [{ id: "low-contrast-1", why: "a" }, { id: "made-up-9", why: "b" }, { id: "low-contrast-1", why: "c" }] }, findings);
    expect(checked.reply.priorities).toEqual([{ id: "low-contrast-1", why: "a" }]);
    expect(checked.dropped).toBe(2);
  });

  it("ranks findings by what they cost (Demo mode order)", () => {
    expect(rankFindings([finding("no-h1", "low"), finding("small-text", "high", "medium"), finding("overlap", "high")]).map((item) => item.type)).toEqual(["overlap", "small-text", "no-h1"]);
  });
});
