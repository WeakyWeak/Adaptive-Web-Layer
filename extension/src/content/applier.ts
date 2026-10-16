// ─── Settings → plan applier ─────────────────────────────────────────────────
// Converts TypographyPrefs into a list of PlanSteps and applies them
// through the Operation registry. This is THE ONLY place that maps
// settings to operations; popup, options, and agent loop all call here.

import type { AppearancePrefs, TypographyPrefs } from "../shared/settings";
import { applyPlan, type ApplyContext, type PlanStep, type Revert } from "../shared/registry";
import { appearancePlanSteps } from "./appearanceOps";

// Keep track of the current revert handle so re-applying always does a clean replace
let _currentRevert: Revert | null = null;
const _appearanceApplied = new Map<string, { signature: string; revert: Revert }>();
let _appearanceReset: Revert | null = null;
let _currentPrefs: TypographyPrefs | null = null;
const _undo: TypographyPrefs[] = [];

/**
 * Apply a TypographyPrefs object to the page via the registry.
 * Calling this again replaces the previous application completely.
 * Returns a combined Revert function.
 */
export function applyTypography(ctx: ApplyContext, prefs: TypographyPrefs): Revert {
  // Revert any previous application first
  if (_currentRevert) {
    if (_currentPrefs) _undo.push(_currentPrefs);
    if (_undo.length > 10) _undo.shift();
    _currentRevert();
    _currentRevert = null;
  }

  const steps: PlanStep[] = [
    { opId: "fontFamily", params: { value: prefs.fontFamily } },
    { opId: "fontSize", params: { value: prefs.fontSize } },
    { opId: "lineHeight", params: { value: prefs.lineHeight } },
    { opId: "letterSpacing", params: { value: prefs.letterSpacing } },
    { opId: "wordSpacing", params: { value: prefs.wordSpacing } },
    { opId: "paragraphSpacing", params: { value: prefs.paragraphSpacing } },
    { opId: "maxContentWidth", params: { value: prefs.maxContentWidth } },
  ];

  const result = applyPlan(ctx, steps);
  if (result.errors.length > 0) {
    console.warn("[AWL applier] plan had errors:", result.errors);
  }

  _currentRevert = result.revert;
  _currentPrefs = { ...prefs };
  return result.revert;
}

/**
 * Revert all currently applied typography settings and return the page to
 * its original state.
 */
export function revertTypography(): void {
  if (_currentRevert) {
    _currentRevert();
    _currentRevert = null;
  }
  _currentPrefs = null;
  _undo.length = 0;
}

export function undoTypography(ctx: ApplyContext): boolean {
  const previous = _undo.pop();
  if (!previous) return false;
  if (_currentRevert) _currentRevert();
  _currentRevert = applyTypography(ctx, previous);
  _undo.pop();
  return true;
}

export function resetPage(): void { revertTypography(); }

export function applyAppearance(ctx: ApplyContext, prefs: AppearancePrefs, theme = prefs.theme, skipTheme = false): Revert {
  const steps = appearancePlanSteps(prefs, theme, skipTheme);
  const activeIds = new Set(steps.map(({ opId }) => opId));

  // Re-running the settings loader is common on SPAs. Keep unchanged operations
  // mounted so Smart markers and palettes do not disappear/reappear on scroll.
  for (const [id, applied] of [..._appearanceApplied].reverse()) {
    if (activeIds.has(id)) continue;
    applied.revert();
    _appearanceApplied.delete(id);
  }

  for (const step of steps) {
    const signature = JSON.stringify(step.params);
    const current = _appearanceApplied.get(step.opId);
    if (current?.signature === signature) continue;
    current?.revert();
    _appearanceApplied.delete(step.opId);

    const result = applyPlan(ctx, [step]);
    if (result.errors.length) {
      console.warn("[AWL appearance] plan had errors:", result.errors);
      continue;
    }
    _appearanceApplied.set(step.opId, { signature, revert: result.revert });
  }

  if (!_appearanceReset) {
    _appearanceReset = () => {
      for (const { revert } of [..._appearanceApplied.values()].reverse()) revert();
      _appearanceApplied.clear();
      _appearanceReset = null;
    };
  }
  return _appearanceReset;
}

export function revertAppearance(): void {
  _appearanceReset?.();
}

export function resetPageAll(): void {
  revertTypography();
  revertAppearance();
}
