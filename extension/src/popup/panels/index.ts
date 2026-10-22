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
import AppearancePanel from "./AppearancePanel";
import FocusMotionPanel from "./FocusMotionPanel";
// P06R: the AI assistant moved to the side panel; the popup only opens it.
import OpenAiPanel from "./OpenAiPanel";

export const panels: PanelDescriptor[] = [
  { id: "ai-command", title: "✨ AI assistant", Component: OpenAiPanel as ComponentType<Record<string, never>> },
  { id: "reading", title: "Reading", Component: ReadingPanel as ComponentType<Record<string, never>> },
  { id: "appearance", title: "Appearance", Component: AppearancePanel as ComponentType<Record<string, never>> },
  { id: "focus-motion", title: "Focus & Motion", Component: FocusMotionPanel as ComponentType<Record<string, never>> },
];

