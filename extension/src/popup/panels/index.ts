// Panel registry — each phase adds a panel here without editing shared code.
// Import order = display order.

import type { ComponentType } from "react";

export interface PanelDescriptor {
  id: string;
  title: string;
  Component: ComponentType<Record<string, never>>;
}

// P01: Reading panel (typography settings + live preview)
import ReadingPanel from "./ReadingPanel";

export const panels: PanelDescriptor[] = [
  { id: "reading", title: "Reading", Component: ReadingPanel as ComponentType<Record<string, never>> },
];
