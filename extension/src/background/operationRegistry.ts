// ─── Planning operation registry ────────────────────────────────────────────
// The content script and MV3 background worker run in different JavaScript
// contexts. Register the same definitions in the worker so the planner can
// describe and validate operations before sending them to the content script.

import { registerAppearanceOps } from "../content/appearanceOps";
import { registerFocusOps } from "../content/focusOps";
import { registerTypographyOps } from "../content/typographyOps";

let registered = false;

export function registerPlanningOperations(): void {
  if (registered) return;
  registerTypographyOps();
  registerAppearanceOps();
  registerFocusOps();
  registered = true;
}
