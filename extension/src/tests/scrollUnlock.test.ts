// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SCROLL_UNLOCK, scrollUnlockCss } from "../content/focusOps";

// jsdom has no layout: the page is "taller than the window" when we say so.
const setHeight = (px: number) => Object.defineProperty(document.documentElement, "scrollHeight", { configurable: true, value: px });

describe("scroll lock left by a hidden pop-up", () => {
  beforeEach(() => {
    document.body.innerHTML = `<div class="newsletter-modal" style="position: fixed; inset: 0">Subscribe!</div><div class="promo">Sale</div><p>Article</p>`;
    // jsdom does not expand the overflow shorthand, so set the longhand sites end up with.
    document.body.style.overflowY = "hidden";
    setHeight(5000);
  });
  afterEach(() => {
    document.documentElement.removeAttribute(SCROLL_UNLOCK);
    document.body.removeAttribute("style");
  });

  it("gives scrolling back when a hidden overlay had locked a long page", () => {
    const css = scrollUnlockCss([".newsletter-modal"]);
    expect(css).toContain("overflow-y: auto !important");
    expect(document.documentElement.hasAttribute(SCROLL_UNLOCK)).toBe(true);
    // Our own rule makes the page look unlocked; the mark keeps the decision.
    document.body.style.overflowY = "auto";
    expect(scrollUnlockCss([".newsletter-modal"])).not.toBeNull();
  });

  it("leaves the page alone when what is hidden is not an overlay, or the page does not scroll anyway", () => {
    expect(scrollUnlockCss([".promo"])).toBeNull();
    setHeight(100);
    expect(scrollUnlockCss([".newsletter-modal"])).toBeNull();
  });

  it("leaves pages that were never locked alone", () => {
    document.body.style.overflowY = "visible";
    expect(scrollUnlockCss([".newsletter-modal"])).toBeNull();
  });
});
