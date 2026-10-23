// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { applyPlan, type StyleLayer } from "../shared/registry";
import { registerFocusOps } from "../content/focusOps";
import { followsGesture, settleScriptAnimations } from "../content/motionOps";

function layer(): StyleLayer & { rules: Map<string, string> } { const rules = new Map<string, string>(); return { rules, set: (id, value) => rules.set(id, value), get: (id) => rules.get(id), remove: (id) => rules.delete(id), clear: () => rules.clear() }; }
const ctx = () => ({ styleLayer: layer(), applyToWholePage: false });
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** jsdom media never plays; stub the bits the operation reads and calls. */
function media(html: string): HTMLMediaElement {
  const template = document.createElement("template");
  template.innerHTML = html;
  const element = template.content.firstElementChild as HTMLMediaElement;
  let paused = false;
  Object.defineProperty(element, "paused", { get: () => paused });
  element.pause = vi.fn(() => { paused = true; });
  return element;
}

beforeAll(registerFocusOps);
afterEach(() => { document.body.innerHTML = ""; });

describe("reduce motion", () => {
  it("shortens animations to one instant run instead of removing them, keeping progress indicators", () => {
    const current = ctx();
    const result = applyPlan(current, [{ opId: "reduceMotion", params: { enabled: true } }]);
    const css = current.styleLayer.rules.get("reduceMotion")!;
    expect(css).toContain("animation-duration: .01ms !important");
    expect(css).toContain("animation-iteration-count: 1 !important");
    expect(css).toContain("transition-duration: .01ms !important");
    expect(css).not.toContain("animation: none");
    expect(css).toContain(":not([role='progressbar'])");
    result.revert();
    expect(current.styleLayer.rules.size).toBe(0);
  });

  it("finishes finite script animations and pauses endless ones", () => {
    const finite = { playState: "running", effect: { getComputedTiming: () => ({ endTime: 300 }) }, finish: vi.fn(), pause: vi.fn() };
    const endless = { playState: "running", effect: { getComputedTiming: () => ({ endTime: Infinity }) }, finish: vi.fn(), pause: vi.fn() };
    const idle = { playState: "paused", effect: null, finish: vi.fn(), pause: vi.fn() };
    const doc = { getAnimations: () => [finite, endless, idle] } as unknown as Document;
    const paused = new Set<Animation>();
    settleScriptAnimations(doc, paused);
    expect(finite.finish).toHaveBeenCalled();
    expect(endless.pause).toHaveBeenCalled();
    expect(idle.finish).not.toHaveBeenCalled();
    expect([...paused]).toEqual([endless]);
  });
});

describe("reduce parallax", () => {
  it("is plain CSS, so elements added later are covered too", () => {
    const current = ctx();
    applyPlan(current, [{ opId: "reduceParallax", params: { enabled: true } }]);
    const css = current.styleLayer.rules.get("reduceParallax")!;
    expect(css).toContain("background-attachment: scroll !important");
    expect(css).toContain("[class*='parallax' i]");
    expect(css).not.toContain("data-awl-parallax-target");
    expect(css).not.toContain("scroll' i]");
  });
});

describe("pause autoplay", () => {
  it("pauses media started by script, not only media with the autoplay attribute", () => {
    const result = applyPlan(ctx(), [{ opId: "pauseAutoplay", params: { enabled: true } }]);
    const video = media("<video src='a.mp4'></video>");
    document.body.append(video);
    video.dispatchEvent(new Event("play"));
    expect(video.pause).toHaveBeenCalled();
    result.revert();
  });

  it("disarms the autoplay attribute on media added later, and restores it on revert", async () => {
    const result = applyPlan(ctx(), [{ opId: "pauseAutoplay", params: { enabled: true } }]);
    const wrapper = document.createElement("div");
    const video = media("<video src='a.mp4' autoplay muted loop></video>");
    wrapper.append(video);
    document.body.append(wrapper);
    await flush();
    expect(video.autoplay).toBe(false);
    result.revert();
    expect(video.autoplay).toBe(true);
  });

  it("stops watching once turned off", () => {
    applyPlan(ctx(), [{ opId: "pauseAutoplay", params: { enabled: true } }]).revert();
    const video = media("<video src='a.mp4'></video>");
    document.body.append(video);
    video.dispatchEvent(new Event("play"));
    expect(video.pause).not.toHaveBeenCalled();
  });

  it("treats playback right after a press, or soon after a press on the player, as the user's", () => {
    document.body.innerHTML = "<div class='player'><video></video><button class='play'>Play</button></div><p class='elsewhere'>text</p>";
    const video = document.querySelector("video")!;
    const button = document.querySelector(".play")!;
    const elsewhere = document.querySelector(".elsewhere")!;
    expect(followsGesture(video, { at: 1000, target: elsewhere }, 1500)).toBe(true);
    expect(followsGesture(video, { at: 1000, target: elsewhere }, 4000)).toBe(false);
    expect(followsGesture(video, { at: 1000, target: button }, 4000)).toBe(true); // slow-loading player
    expect(followsGesture(video, { at: 1000, target: button }, 20000)).toBe(false);
    expect(followsGesture(video, { at: -Infinity, target: null }, 1000)).toBe(false);
  });
});
