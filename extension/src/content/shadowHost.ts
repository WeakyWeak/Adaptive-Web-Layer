// In-page UI lives in a closed Shadow DOM: page CSS cannot restyle it and its
// styles do not leak. `data-awl-preserve` keeps the Fast dark filter, Smart
// palette and typography operations away from it.

export const UI_FONT = "font: 14px/1.5 system-ui, -apple-system, 'Segoe UI', sans-serif;";
export const UI_THEME = `
  :host { all: initial; }
  .panel { ${UI_FONT} color: #1f2937; background: #ffffff; border: 1px solid #d1d5db; border-radius: 10px; box-shadow: 0 8px 28px rgba(15, 23, 42, .18); }
  button { font: inherit; cursor: pointer; border: 1px solid #c7d2fe; background: #eef2ff; color: #3730a3; border-radius: 6px; padding: 4px 10px; }
  button:hover { background: #e0e7ff; }
  button:focus-visible { outline: 2px solid #4f46e5; outline-offset: 2px; }
  .muted { color: #6b7280; font-size: 12px; }
  .chip { display: inline-block; font-size: 11px; padding: 1px 7px; border-radius: 999px; background: #f3f4f6; color: #374151; }
  @media (prefers-color-scheme: dark) {
    .panel { color: #e5e7eb; background: #1f2937; border-color: #374151; }
    button { background: #312e81; color: #e0e7ff; border-color: #4338ca; }
    button:hover { background: #3730a3; }
    .muted { color: #9ca3af; }
    .chip { background: #374151; color: #e5e7eb; }
  }`;

export function createShadowHost(name: string, css: string, hostStyle: string): { host: HTMLElement; root: ShadowRoot } {
  const host = document.createElement("div");
  host.setAttribute("data-awl-overlay", name);
  host.setAttribute("data-awl-preserve", "");
  host.style.cssText = hostStyle;
  const root = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = `${UI_THEME}\n${css}`;
  root.append(style);
  return { host, root };
}

/** Small element factory: text only (never HTML), so page or model text cannot inject markup. */
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...children: Array<Node | string>): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, value);
  element.append(...children);
  return element;
}

export const SOURCE_LABEL: Record<string, string> = { local: "Local AI", cloud: "Cloud AI", sarvam: "Sarvam (cloud)", demo: "Demo mode, no AI" };
