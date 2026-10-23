// @vitest-environment jsdom
// Smart theme on a real (jsdom) DOM: text must stay readable on the background
// it ends up on, including headers Smart does not recolour.

import { afterEach, describe, expect, it } from "vitest";
import { contrastRatio, parseCssColor } from "../lib/color";
import { createSmartPalette, mapSmartColors, pickTextColor, type SmartPalette } from "../content/smartPalette";

let palette: SmartPalette | undefined;
afterEach(() => { palette?.stop(); palette = undefined; document.body.innerHTML = ""; document.body.removeAttribute("style"); });

/** The colour a marked element gets, read from the palette's rules. */
function ruleFor(element: Element, property: "color" | "background-color"): string | undefined {
  const marker = element.getAttribute("data-awl-smart-target");
  if (!marker) return undefined;
  const rule = palette!.css().split("\n").find((line) => line.includes(`"${marker}"`));
  return rule?.match(new RegExp(`(?:^|[ {;])${property}: (#[0-9a-f]{6})`))?.[1];
}
const contrast = (fg: string, bg: string) => contrastRatio(parseCssColor(fg)!, parseCssColor(bg)!);

describe("pickTextColor", () => {
  it("keeps text that is already readable on its background", () => {
    expect(pickTextColor(parseCssColor("#000000")!, parseCssColor("#f4b400")!, "dark")).toBeUndefined();
  });

  it("never picks a colour with less contrast than the original", () => {
    // White on a mid blue (4.2:1): neither theme colour does better, so keep it.
    expect(pickTextColor(parseCssColor("#ffffff")!, parseCssColor("#1a73e8")!, "dark")).toBeUndefined();
  });

  it("falls back to the other theme's text colour on a light block Smart left alone", () => {
    const color = pickTextColor(parseCssColor("#555555")!, parseCssColor("#f4b400")!, "dark")!;
    expect(contrast(color, "#f4b400")).toBeGreaterThanOrEqual(4.5);
  });

  it("still maps the classic cases", () => {
    expect(mapSmartColors("rgb(23, 25, 31)", "rgb(230, 232, 237)", "light")).toEqual({ backgroundColor: "#ffffff", color: "#202124" });
    expect(mapSmartColors("rgb(255, 255, 255)", "rgb(26, 26, 26)", "dark")).toEqual({ backgroundColor: "#202124", color: "#e8eaed" });
  });
});

describe("createSmartPalette (dark)", () => {
  it("does not turn header text light on a mid-tone header it leaves alone", () => {
    document.body.style.backgroundColor = "#ffffff";
    document.body.innerHTML = `<header style="background-color: #f4b400; color: #111111"><h1 style="color: #111111">Site</h1></header><main><p style="color: #222222">Body text</p></main>`;
    palette = createSmartPalette(document, "dark");
    expect(ruleFor(document.body, "background-color")).toBe("#202124");
    expect(ruleFor(document.querySelector("h1")!, "color")).toBeUndefined();
    expect(ruleFor(document.querySelector("p")!, "color")).toBe("#e8eaed");
  });

  it("checks text against the recoloured parent, not the original one", () => {
    document.body.innerHTML = `<nav style="background-color: #eeeeee"><a href="#" style="color: #1a0dab">Home</a><span style="color: #9aa0a6">Muted</span></nav>`;
    palette = createSmartPalette(document, "dark");
    const navBackground = ruleFor(document.querySelector("nav")!, "background-color")!;
    expect(navBackground).toBe("#292a2d");
    for (const element of document.querySelectorAll("nav > *")) {
      const color = ruleFor(element, "color") ?? getComputedStyle(element).color;
      expect(contrast(color, navBackground)).toBeGreaterThanOrEqual(4.5);
    }
    expect(ruleFor(document.querySelector("a")!, "color")).toBe("#8ab4f8");
  });

  it("leaves text over a background image or gradient as the site set it", () => {
    document.body.style.backgroundColor = "#ffffff";
    document.body.innerHTML = `<header style="background-image: linear-gradient(#ffffff, #eeeeee); color: #111111"><h1 style="color: #111111">Hero</h1></header>`;
    palette = createSmartPalette(document, "dark");
    expect(ruleFor(document.querySelector("h1")!, "color")).toBeUndefined();
  });

  it("recolours content added after the theme was applied", async () => {
    // Like the style layer: the rules are live CSS, so later batches see the
    // recoloured body. (jsdom ignores !important over inline styles, so the
    // page colour comes from a stylesheet here.)
    const page = document.head.appendChild(document.createElement("style"));
    page.textContent = "body { background-color: #ffffff; }";
    const style = document.head.appendChild(document.createElement("style"));
    palette = createSmartPalette(document, "dark", (css) => { style.textContent = css; });
    style.textContent = palette.css();
    const late = document.createElement("div");
    late.innerHTML = `<p style="color: #333333">Rendered later</p>`;
    document.body.append(late);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(ruleFor(late.querySelector("p")!, "color")).toBe("#e8eaed");
    expect(style.textContent).toContain(late.querySelector("p")!.getAttribute("data-awl-smart-target"));
    style.remove();
    page.remove();
  });

  it("removes every marker when stopped", () => {
    document.body.style.backgroundColor = "#ffffff";
    document.body.innerHTML = `<p style="color: #333333">Text</p>`;
    palette = createSmartPalette(document, "dark");
    expect(document.querySelector("[data-awl-smart-target]")).not.toBeNull();
    palette.stop();
    expect(document.querySelector("[data-awl-smart-target]")).toBeNull();
  });
});
