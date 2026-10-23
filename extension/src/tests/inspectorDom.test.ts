// @vitest-environment jsdom
// Inspector on a (jsdom) DOM: contrast with alpha and nested backgrounds,
// gradients reported with low confidence, heading checks, the scan cap, and
// the low-contrast fix's colour choice. jsdom has no layout, so boxes are stubbed.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { contrastRatio, parseCssColor } from "../lib/color";
import { contrastRange, createBackdropResolver, gradientStops, requiredContrast } from "../content/contrast";
import { inspectPage, measure } from "../content/inspector";
import { contrastColourFor } from "../content/readabilityOps";

const options = () => ({ region: document.querySelector("main") ?? document.body, current: { fontSize: 16, lineHeight: 1.5, maxContentWidth: 800 }, smartColours: false, testFocus: false });

function stubLayout(): void {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, top: 0, left: 0, right: 600, bottom: 20, width: 600, height: 20, toJSON: () => ({}) } as DOMRect);
}

afterEach(() => { vi.restoreAllMocks(); document.body.innerHTML = ""; document.body.removeAttribute("style"); });

describe("backdrop and contrast", () => {
  it("composites translucent backgrounds over the ones below them", () => {
    document.body.innerHTML = `<div id="dark" style="background-color: #333333"><div id="tint" style="background-color: rgba(255, 255, 255, 0.1)"><span id="text" style="color: #666666">Archived</span></div></div>`;
    const backdrop = createBackdropResolver(window)(document.getElementById("text"));
    expect(backdrop).not.toBe("image");
    const bg = backdrop as { r: number };
    // 10% white over #333 is #474747.
    expect(Math.round(bg.r)).toBe(0x47);
    expect(contrastRatio(parseCssColor("#666666")!, backdrop as never)).toBeCloseTo(1.61, 1);
  });

  it("composites translucent text over its background", () => {
    expect(contrastRatio(parseCssColor("rgba(0, 0, 0, 0.3)")!, parseCssColor("#ffffff")!)).toBeCloseTo(2.11, 1);
  });

  it("treats a gradient behind text as an image and reads its colour stops", () => {
    document.body.innerHTML = `<div style="background-image: linear-gradient(90deg, #1e3a8a, #bfdbfe)"><p id="hero" style="color: #ffffff">Notice</p></div>`;
    expect(createBackdropResolver(window)(document.getElementById("hero"))).toBe("image");
    const stops = gradientStops("linear-gradient(90deg, rgb(30, 58, 138), #bfdbfe)")!;
    expect(stops).toHaveLength(2);
    const range = contrastRange(parseCssColor("#ffffff")!, stops);
    expect(range.min).toBeLessThan(2);
    expect(range.max).toBeGreaterThan(9);
    expect(gradientStops("url(a.png), linear-gradient(red, blue)")).toBeNull();
  });

  it("uses the large-text threshold for big or bold text", () => {
    expect(requiredContrast({ fontSize: "16px", fontWeight: "400" })).toBe(4.5);
    expect(requiredContrast({ fontSize: "24px", fontWeight: "400" })).toBe(3);
    expect(requiredContrast({ fontSize: "19px", fontWeight: "bold" })).toBe(3);
  });

  it("picks a replacement text colour that passes on the real background", () => {
    for (const [background, link] of [["#ffffff", false], ["#474747", false], ["#ffffff", true], ["#0f172a", true]] as const) {
      const key = contrastColourFor(parseCssColor(background)!, link);
      const colour = { d: "#111111", l: "#f8f8f8", ld: "#0b57d0", ll: "#a8c7fa" }[key];
      expect(contrastRatio(parseCssColor(colour)!, parseCssColor(background)!)).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrastColourFor(parseCssColor("#ffffff")!, true)).toBe("ld");
  });
});

describe("inspectPage", () => {
  beforeEach(stubLayout);

  it("reports measured low contrast with high confidence and a gradient with low confidence", async () => {
    document.body.innerHTML = `<main>
      <h1>Title</h1>
      <p style="color: #aaaaaa; font-size: 16px">Residents can call the priority line before the supply drops.</p>
      <div style="background-image: linear-gradient(90deg, #1e3a8a, #bfdbfe)"><p style="color: #ffffff; font-size: 16px">Water supply notice for the eastern wards.</p></div>
      <p style="color: #222222; font-size: 16px">Readable text stays out of the report entirely.</p>
    </main>`;
    const report = await inspectPage(document, options());
    const contrast = report.findings.filter((item) => item.type === "low-contrast");
    expect(contrast).toHaveLength(2);
    expect(contrast[0]).toMatchObject({ confidence: "high", severity: "high", evidence: { ratio: 2.32, required: 4.5, foreground: "#aaaaaa", background: "#ffffff" }, suggestedFix: { changes: { fixContrast: true } } });
    expect(contrast[1]).toMatchObject({ confidence: "low", title: expect.stringContaining("gradient") });
    expect(contrast[1].suggestedFix).toBeUndefined();
    // Highlight refs are snapshot ids, ids are stable per type.
    expect(contrast[0].elementRef).toMatch(/^s\d+$/);
    expect(contrast.map((item) => item.id)).toEqual(["low-contrast-1", "low-contrast-2"]);
  });

  it("does not offer the contrast fix when Smart colours already handle it", async () => {
    document.body.innerHTML = `<main><h1>T</h1><p style="color: #aaaaaa">Faint text on a white page.</p></main>`;
    const report = await inspectPage(document, { ...options(), smartColours: true });
    const contrast = report.findings.find((item) => item.type === "low-contrast")!;
    expect(contrast.suggestedFix).toBeUndefined();
    expect(contrast.advice).toBeTruthy();
  });

  it("reports heading problems with the first affected heading as the highlight", async () => {
    document.body.innerHTML = `<main><h2>Start</h2><h4 id="jump">Jump</h4><h3 id="empty"></h3><h3 style="display: none"></h3></main>`;
    const report = await inspectPage(document, options());
    expect(report.findings.filter((item) => item.id.match(/h1|heading/)).map((item) => item.type)).toEqual(["no-h1", "skipped-heading", "empty-heading"]);
    const empty = report.findings.find((item) => item.type === "empty-heading")!;
    expect(empty.evidence.affected).toBe(1); // the hidden empty heading is not counted
    expect(document.querySelector(`[data-awl-snap="${empty.elementRef}"]`)?.id).toBe("empty");
  });

  it("finds nothing on a clean page", async () => {
    document.body.innerHTML = `<main><h1>Title</h1><h2>Part</h2><p style="color: #222222; font-size: 18px">Plain readable text.</p></main>`;
    const report = await inspectPage(document, options());
    expect(report.findings).toEqual([]);
  });
});

describe("scan budget", () => {
  it("never reads more than the cap, and says when it stopped there", async () => {
    document.body.innerHTML = "<div></div>".repeat(5000);
    const style = vi.spyOn(window, "getComputedStyle");
    const capped = await measure(document.body, 4000);
    expect(capped).toMatchObject({ scanned: 4000, capped: true });
    expect(style.mock.calls.length).toBeLessThanOrEqual(4000);
    expect(await measure(document.body, 6000)).toMatchObject({ scanned: 5000, capped: false });
  });
});
