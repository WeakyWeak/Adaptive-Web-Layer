// ─── Motion operations ───────────────────────────────────────────────────────
// Reduce motion, reduce parallax and pause autoplay. CSS covers content added
// later on its own; autoplay and script animations need small watchers.

import { z } from "zod";
import type { Operation } from "../shared/registry";
import { setStyleEntry } from "./styleEntry";

const enabledSchema = z.object({ enabled: z.boolean() });
// Progress indicators keep moving: they tell the user something is happening.
const MOVING = [":not(progress):not([role='progressbar']):not([aria-busy='true'])", "::before", "::after"]
  .map((part, index, all) => index === 0 ? part : `${all[0]}${part}`).join(", ");
// Animations run once and end at once instead of being removed: content that
// fades in (or waits for animationend / transitionend) still appears.
const REDUCE_MOTION_CSS = `:root { scroll-behavior: auto !important; } ${MOVING} { animation-duration: .01ms !important; animation-iteration-count: 1 !important; animation-delay: 0s !important; transition-duration: .01ms !important; transition-delay: 0s !important; scroll-behavior: auto !important; } :focus-visible { outline: auto !important; }`;
const PARALLAX_SELECTOR = "[class*='parallax' i], [data-parallax], [data-rellax-speed], .rellax, [data-scroll-speed], [data-speed]";
const REDUCE_PARALLAX_CSS = `*, *::before, *::after { background-attachment: scroll !important; } ${PARALLAX_SELECTOR} { transform: none !important; translate: none !important; }`;
const SCRIPT_ANIMATION_POLL_MS = 500;

/** Finish (or, if endless, pause) animations started from script; CSS ones are handled by the stylesheet. */
export function settleScriptAnimations(doc: Document, paused: Set<Animation>): void {
  if (typeof doc.getAnimations !== "function") return;
  for (const animation of doc.getAnimations()) {
    if (animation.playState !== "running") continue;
    if (typeof CSSAnimation !== "undefined" && animation instanceof CSSAnimation) continue;
    if (typeof CSSTransition !== "undefined" && animation instanceof CSSTransition) continue;
    try {
      const end = animation.effect?.getComputedTiming().endTime;
      if (typeof end === "number" && Number.isFinite(end)) animation.finish();
      else { animation.pause(); paused.add(animation); }
    } catch { /* an animation the page already cancelled */ }
  }
}

const reduceMotion: Operation<{ enabled: boolean }> = {
  id: "reduceMotion", label: "Reduce motion", target: "content-region", protectedElements: [], paramsSchema: enabledSchema, validate: () => null,
  apply(ctx, params) {
    if (!params.enabled) return setStyleEntry(ctx, "reduceMotion", null);
    const paused = new Set<Animation>();
    let timer: ReturnType<typeof setInterval> | undefined;
    if (typeof document !== "undefined") {
      settleScriptAnimations(document, paused);
      timer = setInterval(() => settleScriptAnimations(document, paused), SCRIPT_ANIMATION_POLL_MS);
    }
    return setStyleEntry(ctx, "reduceMotion", REDUCE_MOTION_CSS, () => {
      if (timer) clearInterval(timer);
      paused.forEach((animation) => { try { animation.play(); } catch { /* gone */ } });
    });
  },
};

const reduceParallax: Operation<{ enabled: boolean }> = {
  id: "reduceParallax", label: "Reduce parallax", target: "content-region", protectedElements: [], paramsSchema: enabledSchema, validate: () => null,
  apply(ctx, params) { return setStyleEntry(ctx, "reduceParallax", params.enabled ? REDUCE_PARALLAX_CSS : null); },
};

// ─── Autoplay ────────────────────────────────────────────────────────────────
// Playback the user asked for (a press just before it, or a press on or near
// the player shortly before it) is remembered and never paused. Anything else
// is paused as soon as it starts, whether by the autoplay attribute or by script.
const userStarted = new WeakSet<HTMLMediaElement>();
let lastGesture: Gesture = { at: -Infinity, target: null };
let tracking = false;
const PLAY_KEYS = new Set(["Enter", " ", "k", "K", "MediaPlayPause", "MediaPlay"]);
const ANY_GESTURE_MS = 1000;
const NEAR_GESTURE_MS = 8000;

function nearMedia(target: EventTarget | null, media: HTMLMediaElement): boolean {
  let node = target instanceof Element ? target : null;
  for (let depth = 0; node && depth < 6 && node !== node.ownerDocument.body && node !== node.ownerDocument.documentElement; depth++, node = node.parentElement) {
    if (node.contains(media)) return true;
  }
  return false;
}

export interface Gesture { at: number; target: EventTarget | null }

/** Whether playback starting `now` follows the user's press closely enough to be theirs. */
export function followsGesture(media: HTMLMediaElement, gesture: Gesture, now = Date.now()): boolean {
  const elapsed = now - gesture.at;
  return elapsed < ANY_GESTURE_MS || (elapsed < NEAR_GESTURE_MS && nearMedia(gesture.target, media));
}

function userRequestedPlay(media: HTMLMediaElement): boolean {
  return userStarted.has(media) || followsGesture(media, lastGesture);
}

/** Watch presses from page load on, so playback started before the setting was turned on is known. */
export function trackUserPlayback(doc: Document): void {
  if (tracking) return;
  tracking = true;
  const remember = (event: Event) => { if (event.isTrusted) lastGesture = { at: Date.now(), target: event.target }; };
  doc.addEventListener("pointerdown", remember, { capture: true, passive: true });
  doc.addEventListener("keydown", (event) => { if (PLAY_KEYS.has(event.key)) remember(event); }, { capture: true, passive: true });
  doc.addEventListener("play", (event) => {
    const media = event.target;
    if (media instanceof HTMLMediaElement && userRequestedPlay(media)) userStarted.add(media);
  }, true);
}

const pauseAutoplay: Operation<{ enabled: boolean }> = {
  id: "pauseAutoplay", label: "Pause autoplay media", target: "content-region", protectedElements: [], paramsSchema: enabledSchema, validate: () => null,
  apply(ctx, params) {
    if (typeof document === "undefined") return setStyleEntry(ctx, "pauseAutoplay", null);
    trackUserPlayback(document);
    if (!params.enabled) return setStyleEntry(ctx, "pauseAutoplay", null);
    const disarmed: HTMLMediaElement[] = [];
    const stop = (media: HTMLMediaElement) => {
      // Clearing the attribute before loading finishes stops the start outright.
      if (media.autoplay) { media.autoplay = false; disarmed.push(media); }
      if (!media.paused && !userStarted.has(media)) media.pause();
    };
    const sweep = (root: ParentNode) => {
      if (root instanceof HTMLMediaElement) stop(root);
      root.querySelectorAll<HTMLMediaElement>("video, audio").forEach(stop);
    };
    const onPlay = (event: Event) => {
      const media = event.target;
      if (media instanceof HTMLMediaElement && !userRequestedPlay(media)) media.pause();
    };
    sweep(document);
    document.addEventListener("play", onPlay, true);
    const observer = new MutationObserver((records) => records.forEach((record) => record.addedNodes.forEach((node) => { if (node instanceof Element) sweep(node); })));
    observer.observe(document.documentElement, { childList: true, subtree: true });
    return setStyleEntry(ctx, "pauseAutoplay", null, () => {
      observer.disconnect();
      document.removeEventListener("play", onPlay, true);
      disarmed.forEach((media) => { media.autoplay = true; });
    });
  },
};

export const motionOperations = [reduceMotion, reduceParallax, pauseAutoplay] as Operation<unknown>[];
