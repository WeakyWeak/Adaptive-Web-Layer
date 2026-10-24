// ─── Reading controls shared by the popup and Options (P11) ─────────────────
// Spacing comes in research-backed em steps; the text-shape switches and the
// background tint are plain on/off and one-of choices.

import React from "react";
import { BACKGROUND_TINTS, type BackgroundTint, type TypographyPrefs } from "../shared/settings";

export const TEXT_SHAPE_TOGGLES = [
  ["unjustify", "Left-align justified text"],
  ["noItalics", "Upright text instead of italics"],
  ["noAllCaps", "No ALL CAPS styling"],
] as const satisfies ReadonlyArray<readonly [keyof TypographyPrefs, string]>;

export const TINT_LABELS: Record<BackgroundTint, string> = {
  none: "None (site colours)",
  cream: "Cream",
  peach: "Peach",
  yellow: "Soft yellow",
  "soft-grey": "Soft grey",
};
export const TINT_OPTIONS = BACKGROUND_TINTS.map((value) => ({ value, label: TINT_LABELS[value] }));

export interface ClassNames { row: string; label: string; value: string; select: string }

/** A one-of select over em presets; a value saved before the presets existed stays selectable. */
export function SpacingSelect({ id, label, value, presets, classes, onChange }: {
  id: string;
  label: string;
  value: number;
  presets: readonly number[];
  classes: ClassNames;
  onChange: (value: number) => void;
}): React.ReactElement {
  const options = presets.includes(value) ? presets : [...presets, value].sort((a, b) => a - b);
  return (
    <div className={classes.row}>
      <label htmlFor={id} className={classes.label}>{label} <span className={classes.value}>{value}em</span></label>
      <select id={id} className={classes.select} value={String(value)} onChange={(event) => onChange(Number(event.target.value))}>
        {options.map((option) => <option key={option} value={String(option)}>{option === 0 ? "Normal" : `+${option}em`}</option>)}
      </select>
    </div>
  );
}
