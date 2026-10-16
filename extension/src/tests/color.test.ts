import { describe, expect, it } from "vitest";
import { compositeColor, contrastRatio, isDarkCssColor, parseCssColor, relativeLuminance } from "../lib/color";

describe("CSS color parsing and contrast", () => {
  it("computes the WCAG black/white contrast ratio", () => {
    expect(contrastRatio(parseCssColor("#000")!, parseCssColor("#fff")!)).toBeCloseTo(21, 5);
  });

  it("computes a known gray-on-white ratio", () => {
    expect(contrastRatio(parseCssColor("#777")!, parseCssColor("white")!)).toBeCloseTo(4.478, 2);
  });

  it("parses rgba and composites alpha over the supplied background", () => {
    const translucentBlack = parseCssColor("rgba(0, 0, 0, 0.5)")!;
    const white = parseCssColor("rgb(255 255 255)")!;
    const gray = compositeColor(translucentBlack, white);
    expect(gray.r).toBeCloseTo(127.5);
    expect(relativeLuminance(translucentBlack, white)).toBeCloseTo(relativeLuminance(gray));
    expect(contrastRatio(translucentBlack, white)).toBeCloseTo(3.976, 2);
  });

  it("parses HSL colors and marks dark backgrounds", () => {
    expect(parseCssColor("hsl(0 100% 50%)")?.r).toBeCloseTo(255);
    expect(parseCssColor("hsla(120, 100%, 50%, 50%)")?.a).toBeCloseTo(0.5);
    expect(isDarkCssColor("rgb(18, 18, 18)")).toBe(true);
    expect(isDarkCssColor("#f8f8f8")).toBe(false);
  });

  it("rejects unsupported color syntax", () => {
    expect(parseCssColor("not-a-color")).toBeNull();
  });
});
