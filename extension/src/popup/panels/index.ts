// Panel registry — each phase adds a panel here without editing shared code.
// Import order = display order.

import type { ComponentType } from "react";

export interface PanelDescriptor {
  id: string;
  title: string;
  Component: ComponentType<Record<string, never>>;
}

// Registry starts empty; phases will push() or import-inject their panels.
// P00: no panels beyond the status panel (built into the popup root).
export const panels: PanelDescriptor[] = [];
