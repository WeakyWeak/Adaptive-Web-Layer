// Side-panel section registry: later phases (inspector, agent loop) add a
// section here without editing the shell.

import type { ComponentType } from "react";
import type { Settings } from "../../shared/settings";
import type { ActiveTab } from "../hooks";
import AiPanel from "./AiPanel";
import InspectPanel from "./InspectPanel";
import UnderstandPanel from "./UnderstandPanel";

export interface SidePanelSectionProps {
  tab: ActiveTab | null;
  settings: Settings;
}

export interface SidePanelSection {
  id: string;
  title: string;
  Component: ComponentType<SidePanelSectionProps>;
}

export const sections: SidePanelSection[] = [
  { id: "ai", title: "Ask AI to adapt this page", Component: AiPanel },
  { id: "understand", title: "Understand this page", Component: UnderstandPanel },
  { id: "inspect", title: "Inspect", Component: InspectPanel },
];
