// ─── Font injection ───────────────────────────────────────────────────────────
// Injects @font-face rules for bundled OFL-licensed fonts using extension URLs.
// Called once at content script startup.

import type { StyleLayer } from "../shared/registry";

export function injectBundledFonts(layer: StyleLayer): void {
  const base = chrome.runtime.getURL("fonts/");
  const css = `
@font-face {
  font-family: "Lexend";
  src: url("${base}Lexend-Regular.ttf") format("truetype");
  font-weight: 400;
  font-style: normal;
  font-display: swap;
}
@font-face {
  font-family: "Atkinson Hyperlegible";
  src: url("${base}AtkinsonHyperlegible-Regular.ttf") format("truetype");
  font-weight: 400;
  font-style: normal;
  font-display: swap;
}
`.trim();

  layer.set("__fonts__", css);
}
