// ─── Hover outline (P07) ─────────────────────────────────────────────────────
// Draws a box over one page element while the side panel hovers its plan item.
// Lives in a closed Shadow DOM so page CSS cannot restyle it, and never takes
// pointer events.

export class ElementOutline {
  private host: HTMLElement | null = null;
  private box: HTMLDivElement | null = null;
  private target: Element | null = null;

  show(element: Element): void {
    this.target = element;
    if (!this.host) this.mount();
    const rect = element.getBoundingClientRect();
    const offscreen = rect.bottom < 0 || rect.top > window.innerHeight;
    if (offscreen) element.scrollIntoView({ block: "center", behavior: "auto" });
    this.position();
  }

  hide(): void {
    this.target = null;
    window.removeEventListener("scroll", this.position, true);
    window.removeEventListener("resize", this.position);
    this.host?.remove();
    this.host = null;
    this.box = null;
  }

  private mount(): void {
    const host = document.createElement("div");
    host.setAttribute("data-awl-overlay", "outline");
    host.style.cssText = "position:fixed;inset:0;z-index:2147483647;pointer-events:none;";
    const root = host.attachShadow({ mode: "closed" });
    const box = document.createElement("div");
    box.style.cssText = "position:fixed;border:3px solid #6366f1;background:rgba(99,102,241,.14);border-radius:4px;box-shadow:0 0 0 9999px rgba(15,23,42,.18);pointer-events:none;";
    root.append(box);
    document.documentElement.append(host);
    this.host = host;
    this.box = box;
    window.addEventListener("scroll", this.position, true);
    window.addEventListener("resize", this.position);
  }

  private position = (): void => {
    if (!this.box || !this.target) return;
    const rect = this.target.getBoundingClientRect();
    Object.assign(this.box.style, { left: `${rect.left - 3}px`, top: `${rect.top - 3}px`, width: `${rect.width + 6}px`, height: `${rect.height + 6}px` });
  };
}
