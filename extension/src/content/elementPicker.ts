import { sidebarCandidates } from "./focusOps";

export function robustSelector(element: Element): string {
  if (element.id && /^[A-Za-z][\w-]*$/.test(element.id)) return `#${CSS.escape(element.id)}`;
  for (const attribute of ["data-testid", "data-test", "data-awl-id", "aria-label"]) {
    const value = element.getAttribute(attribute);
    if (value && value.length < 80) return `${element.tagName.toLowerCase()}[${attribute}="${CSS.escape(value)}"]`;
  }
  const classes = [...element.classList].filter((item) => /^[A-Za-z][\w-]{1,40}$/.test(item)).slice(0, 2);
  return `${element.tagName.toLowerCase()}${classes.map((item) => `.${CSS.escape(item)}`).join("")}`;
}

export class ElementPicker {
  private readonly root: ShadowRoot; private readonly marker: HTMLDivElement; private readonly shield: HTMLDivElement; private current: Element | null = null;
  constructor(private readonly onSelect: (selector: string, action: "hide" | "preserve") => void, private readonly onCancel: () => void) {
    const host = document.createElement("div"); host.setAttribute("data-awl-picker", "1"); host.style.cssText = "position:fixed;inset:0;z-index:2147483647;pointer-events:auto;"; document.documentElement.append(host); this.root = host.attachShadow({ mode: "closed" });
    this.shield = document.createElement("div"); this.shield.style.cssText = "position:fixed;inset:0;cursor:crosshair;background:transparent;"; this.root.append(this.shield);
    this.marker = document.createElement("div"); this.marker.setAttribute("role", "status"); this.marker.textContent = "Click an element to hide • Shift-click to preserve • Esc to cancel";
    this.marker.style.cssText = "position:fixed;z-index:1;pointer-events:none;border:2px solid #6366f1;background:rgba(99,102,241,.12);color:#111827;font:12px system-ui;padding:4px;"; this.root.append(this.marker);
    this.shield.addEventListener("pointermove", this.move); this.shield.addEventListener("click", this.click); document.addEventListener("keydown", this.key, true);
  }
  private targetAt(x: number, y: number): Element | null { const host = this.root.host as HTMLElement; host.style.pointerEvents = "none"; const target = document.elementFromPoint(x, y); host.style.pointerEvents = "auto"; return target instanceof Element ? target : null; }
  private move = (event: PointerEvent) => { const target = this.targetAt(event.clientX, event.clientY); if (!target) return; this.current = target; const box = target.getBoundingClientRect(); Object.assign(this.marker.style, { left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px` }); };
  private click = (event: MouseEvent) => { event.preventDefault(); event.stopPropagation(); const target = this.targetAt(event.clientX, event.clientY) ?? this.current; if (!target) return; const selector = robustSelector(target); this.onSelect(selector, event.shiftKey ? "preserve" : "hide"); this.dispose(); };
  private key = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); this.onCancel(); this.dispose(); } };
  dispose(): void { this.shield.removeEventListener("pointermove", this.move); this.shield.removeEventListener("click", this.click); document.removeEventListener("keydown", this.key, true); this.root.host.remove(); }
}
export function focusCandidates(): Array<{ selector: string; label: string }> { return sidebarCandidates().slice(0, 12).map((element) => ({ selector: robustSelector(element), label: `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : element.classList.length ? `.${element.classList[0]}` : ""}` })); }
