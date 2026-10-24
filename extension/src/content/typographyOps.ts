// ─── Typography operations ────────────────────────────────────────────────────
// All operations registered here plug into the Operation registry (SPEC §4).
// They target prose elements inside the detected content region.
// Protected elements (pre, code, img, video, etc.) are never touched.

import { z } from "zod";
import { registerOperation, type Operation, type ApplyContext, type Revert, type ApplyResult } from "../shared/registry";
import { FONT_FAMILY_OPTIONS } from "../shared/settings";
import { buildProseSelector, buildRegionSelector, getContentRegionSelector, PROTECTED_ELEMENTS } from "../content/domUtils";
import { textShapeOperations } from "./dyslexiaOps";

// ─── Available fonts ──────────────────────────────────────────────────────────
// OFL-licensed fonts bundled with the extension; names come from the shared allowlist.
const FONT_LABELS: Record<(typeof FONT_FAMILY_OPTIONS)[number], string> = {
  "": "Site default",
  Lexend: "Lexend (may help some readers)",
  "Atkinson Hyperlegible": "Atkinson Hyperlegible (may help some readers)",
  // No reliable evidence that it helps; offered because the fit test may find it does for you.
  OpenDyslexic: "OpenDyslexic (try it in the reading-fit test)",
  Georgia: "Georgia (serif)",
  Verdana: "Verdana (sans-serif)",
  Arial: "Arial (sans-serif)",
  "system-ui": "System UI (sans-serif)",
};
export const FONT_OPTIONS = FONT_FAMILY_OPTIONS.map((value) => ({ value, label: FONT_LABELS[value] }));

// ─── Helper: build the CSS for a given rule ───────────────────────────────────
function makeCss(selector: string, declarations: string): string {
  return `${selector} { ${declarations} }`;
}

// ─── Helper: create a simple CSS-based operation ──────────────────────────────
function makeCssOp<TParams>(
  op: Omit<Operation<TParams>, "apply"> & {
    buildCss: (ctx: ApplyContext, params: TParams) => string | null;
  }
): Operation<TParams> {
  return {
    id: op.id,
    label: op.label,
    target: op.target,
    protectedElements: op.protectedElements,
    paramsSchema: op.paramsSchema,
    validate: op.validate,
    apply(ctx: ApplyContext, params: TParams): ApplyResult {
      const css = op.buildCss(ctx, params);
      const previous = ctx.styleLayer.get(op.id);
      if (css === null) {
        // A neutral value removes an earlier override, and revert restores it.
        ctx.styleLayer.remove(op.id);
        return {
          ok: true,
          revert: () => {
            if (previous !== undefined) ctx.styleLayer.set(op.id, previous);
          },
        };
      }
      ctx.styleLayer.set(op.id, css);
      const revert: Revert = () => {
        if (previous === undefined) ctx.styleLayer.remove(op.id);
        else ctx.styleLayer.set(op.id, previous);
      };
      return { ok: true, revert };
    },
  };
}

// ─── fontFamily ──────────────────────────────────────────────────────────────
const FontFamilyParamsSchema = z.object({ value: z.enum(FONT_FAMILY_OPTIONS) });
type FontFamilyParams = z.infer<typeof FontFamilyParamsSchema>;

const fontFamilyOp = makeCssOp<FontFamilyParams>({
  id: "fontFamily",
  label: "Font family",
  target: "prose",
  protectedElements: PROTECTED_ELEMENTS,
  paramsSchema: FontFamilyParamsSchema,
  validate: () => null,
  buildCss(ctx, params) {
    if (!params.value) return null;
    const region = getContentRegionSelector(ctx.applyToWholePage);
    const selector = buildProseSelector(region);
    return makeCss(selector, `font-family: "${params.value}", system-ui, sans-serif !important`);
  },
});

// ─── fontSize ────────────────────────────────────────────────────────────────
const FontSizeParamsSchema = z.object({
  value: z.number().min(10).max(48),
});
type FontSizeParams = z.infer<typeof FontSizeParamsSchema>;

const fontSizeOp = makeCssOp<FontSizeParams>({
  id: "fontSize",
  label: "Font size (px)",
  target: "prose",
  protectedElements: PROTECTED_ELEMENTS,
  paramsSchema: FontSizeParamsSchema,
  validate(params) {
    if (params.value < 10 || params.value > 48) return "fontSize must be 10–48";
    return null;
  },
  buildCss(ctx, params) {
    if (params.value === 16) return null;
    const region = getContentRegionSelector(ctx.applyToWholePage);
    const selector = buildProseSelector(region);
    return makeCss(selector, `font-size: ${params.value}px !important`);
  },
});

// ─── lineHeight ──────────────────────────────────────────────────────────────
const LineHeightParamsSchema = z.object({
  value: z.number().min(1).max(3),
});
type LineHeightParams = z.infer<typeof LineHeightParamsSchema>;

const lineHeightOp = makeCssOp<LineHeightParams>({
  id: "lineHeight",
  label: "Line height",
  target: "prose",
  protectedElements: PROTECTED_ELEMENTS,
  paramsSchema: LineHeightParamsSchema,
  validate(params) {
    if (params.value < 1 || params.value > 3) return "lineHeight must be 1–3";
    return null;
  },
  buildCss(ctx, params) {
    if (params.value === 1.5) return null;
    const region = getContentRegionSelector(ctx.applyToWholePage);
    const selector = buildProseSelector(region);
    return makeCss(selector, `line-height: ${params.value} !important`);
  },
});

// ─── letterSpacing ────────────────────────────────────────────────────────────
const LetterSpacingParamsSchema = z.object({
  value: z.number().min(-0.05).max(0.5),
});
type LetterSpacingParams = z.infer<typeof LetterSpacingParamsSchema>;

const letterSpacingOp = makeCssOp<LetterSpacingParams>({
  id: "letterSpacing",
  label: "Letter spacing (em)",
  target: "prose",
  protectedElements: PROTECTED_ELEMENTS,
  paramsSchema: LetterSpacingParamsSchema,
  validate(params) {
    if (params.value < -0.05 || params.value > 0.5) return "letterSpacing must be -0.05–0.5em";
    return null;
  },
  buildCss(ctx, params) {
    if (params.value === 0) return null;
    const region = getContentRegionSelector(ctx.applyToWholePage);
    const selector = buildProseSelector(region);
    return makeCss(selector, `letter-spacing: ${params.value}em !important`);
  },
});

// ─── wordSpacing ──────────────────────────────────────────────────────────────
const WordSpacingParamsSchema = z.object({
  value: z.number().min(-0.1).max(1),
});
type WordSpacingParams = z.infer<typeof WordSpacingParamsSchema>;

const wordSpacingOp = makeCssOp<WordSpacingParams>({
  id: "wordSpacing",
  label: "Word spacing (em)",
  target: "prose",
  protectedElements: PROTECTED_ELEMENTS,
  paramsSchema: WordSpacingParamsSchema,
  validate(params) {
    if (params.value < -0.1 || params.value > 1) return "wordSpacing must be -0.1–1em";
    return null;
  },
  buildCss(ctx, params) {
    if (params.value === 0) return null;
    const region = getContentRegionSelector(ctx.applyToWholePage);
    const selector = buildProseSelector(region);
    return makeCss(selector, `word-spacing: ${params.value}em !important`);
  },
});

// ─── paragraphSpacing ─────────────────────────────────────────────────────────
const ParagraphSpacingParamsSchema = z.object({
  value: z.number().min(0).max(5),
});
type ParagraphSpacingParams = z.infer<typeof ParagraphSpacingParamsSchema>;

const paragraphSpacingOp = makeCssOp<ParagraphSpacingParams>({
  id: "paragraphSpacing",
  label: "Paragraph spacing (em)",
  target: "prose",
  protectedElements: PROTECTED_ELEMENTS,
  paramsSchema: ParagraphSpacingParamsSchema,
  validate(params) {
    if (params.value < 0 || params.value > 5) return "paragraphSpacing must be 0–5";
    return null;
  },
  buildCss(ctx, params) {
    if (params.value === 0) return null;
    const region = getContentRegionSelector(ctx.applyToWholePage);
    const selector = buildProseSelector(region);
    return makeCss(selector, `margin-bottom: ${params.value}em !important`);
  },
});

// ─── maxContentWidth ──────────────────────────────────────────────────────────
const MaxContentWidthParamsSchema = z.object({
  value: z.number().min(400).max(2000),
});
type MaxContentWidthParams = z.infer<typeof MaxContentWidthParamsSchema>;

const maxContentWidthOp = makeCssOp<MaxContentWidthParams>({
  id: "maxContentWidth",
  label: "Max content width (px)",
  target: "content-region",
  protectedElements: PROTECTED_ELEMENTS,
  paramsSchema: MaxContentWidthParamsSchema,
  validate(params) {
    if (params.value < 400 || params.value > 2000) return "maxContentWidth must be 400–2000";
    return null;
  },
  buildCss(ctx, params) {
    if (params.value === 800) return null;
    const region = getContentRegionSelector(ctx.applyToWholePage);
    const selector = buildRegionSelector(region);
    return makeCss(selector, `max-width: ${params.value}px !important; margin-left: auto !important; margin-right: auto !important`);
  },
});

// ─── Register all operations ──────────────────────────────────────────────────
export function registerTypographyOps(): void {
  registerOperation(fontFamilyOp);
  registerOperation(fontSizeOp);
  registerOperation(lineHeightOp);
  registerOperation(letterSpacingOp);
  registerOperation(wordSpacingOp);
  registerOperation(paragraphSpacingOp);
  registerOperation(maxContentWidthOp);
  textShapeOperations.forEach(registerOperation);
}

// ─── Export op ids for use in UI ─────────────────────────────────────────────
export const TYPOGRAPHY_OP_IDS = [
  "fontFamily",
  "fontSize",
  "lineHeight",
  "letterSpacing",
  "wordSpacing",
  "paragraphSpacing",
  "maxContentWidth",
] as const;

export type TypographyOpId = (typeof TYPOGRAPHY_OP_IDS)[number];
