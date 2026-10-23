// ─── TL;DR card (P08) ────────────────────────────────────────────────────────
// A collapsible card placed at the top of the main content. It is added next to
// the page's text, never replaces it, and goes away with "Hide".

import type { SummaryResult } from "../shared/comprehension";
import { contentRoot } from "./pageText";
import { createShadowHost, el, SOURCE_LABEL } from "./shadowHost";

const CSS = `
  .panel { display: block; margin: 0 0 20px; padding: 12px 16px; max-width: 760px; }
  summary { cursor: pointer; font-weight: 600; display: flex; gap: 8px; align-items: center; list-style: none; }
  summary::-webkit-details-marker { display: none; }
  summary::before { content: "▾"; font-size: 12px; }
  details:not([open]) summary::before { content: "▸"; }
  .tag { font-size: 11px; letter-spacing: .06em; padding: 2px 8px; border-radius: 999px; background: #4f46e5; color: #fff; }
  ul { margin: 10px 0 6px; padding-left: 22px; }
  li { margin: 4px 0; }
  .row { display: flex; gap: 8px; align-items: center; justify-content: space-between; margin-top: 8px; }
`;

export class SummaryCard {
  private host: HTMLElement | null = null;

  show(summary: SummaryResult, onHide: () => void): void {
    this.hide();
    const { host, root } = createShadowHost("summary", CSS, "display:block;");
    const details = el("details", { open: "" },
      el("summary", {}, el("span", { class: "tag" }, "TL;DR"), `${summary.readingMinutes} min read`),
      el("ul", {}, ...summary.bullets.map((bullet) => el("li", {}, bullet))));
    if (summary.keyTerms.length) details.append(el("p", { class: "muted" }, `Key terms: ${summary.keyTerms.join(", ")}`));
    for (const note of summary.notes) details.append(el("p", { class: "muted" }, note));
    const hide = el("button", { type: "button" }, "Hide");
    hide.addEventListener("click", () => { this.hide(); onHide(); });
    details.append(el("div", { class: "row" }, el("span", { class: "chip" }, `${SOURCE_LABEL[summary.source] ?? summary.source}${summary.cached ? " · saved result" : ""}`), hide));
    root.append(el("section", { class: "panel", role: "region", "aria-label": "TL;DR of this page" }, details));
    const region = contentRoot();
    if (region === document.body) document.body.prepend(host); else region.prepend(host);
    this.host = host;
  }

  hide(): void {
    this.host?.remove();
    this.host = null;
  }
}
