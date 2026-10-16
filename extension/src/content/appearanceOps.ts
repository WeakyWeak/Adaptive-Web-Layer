import { z } from "zod";
import { registerOperation, type ApplyContext, type ApplyResult, type Operation, type Revert } from "../shared/registry";
import { AppearancePrefsSchema } from "../shared/settings";
import type { AppearancePrefs } from "../shared/settings";

export const APPEARANCE_PRESERVE_SELECTOR = [
  "img", "picture", "video", "canvas", "svg", "iframe", "pre", "code", "kbd", "samp",
  "input", "textarea", "select", "button", "[data-awl-preserve]",
].join(", ");
const REINVERT_SELECTOR = ["img", "video", "canvas", "svg", "iframe", "pre", "code:not(pre code)", "kbd:not(pre kbd)", "samp:not(pre samp)", "input", "textarea", "select", "button", "[data-awl-preserve]"].join(", ");

const filterChain = "filter: var(--awl-theme-filter, none) contrast(var(--awl-contrast, 1)) brightness(var(--awl-brightness, 1)) saturate(var(--awl-saturation, 1)) !important;";

function applyCss(ctx: ApplyContext, id: string, css: string | null, restore?: () => void): ApplyResult {
  const previous = ctx.styleLayer.get(id);
  if (css === null) ctx.styleLayer.remove(id);
  else ctx.styleLayer.set(id, css);
  const revert: Revert = () => {
    if (previous === undefined) ctx.styleLayer.remove(id);
    else ctx.styleLayer.set(id, previous);
    restore?.();
  };
  return { ok: true, revert };
}

function variableOperation<T extends { value: number }>(
  id: string,
  label: string,
  paramsSchema: z.ZodType<T>,
  cssVariable: string,
  neutral: number,
  unit = "",
): Operation<T> {
  return {
    id,
    label,
    target: "content-region",
    protectedElements: APPEARANCE_PRESERVE_SELECTOR.split(", "),
    paramsSchema,
    validate: () => null,
    apply(ctx, params) {
      const css = params.value === neutral ? null : `:root { --awl-${cssVariable}: ${params.value}${unit}; ${filterChain} }`;
      return applyCss(ctx, id, css);
    },
  };
}

const ContrastSchema = z.object({ value: z.number().min(0.5).max(2) });
const BrightnessSchema = z.object({ value: z.number().min(0.5).max(1.5) });
const SaturationSchema = z.object({ value: z.number().min(0).max(2) });
const ThemeSchema = z.object({ value: z.enum(["light", "dark", "sepia"]) });

const themeOperation: Operation<z.infer<typeof ThemeSchema>> = {
  id: "theme",
  label: "Color theme",
  target: "content-region",
  protectedElements: APPEARANCE_PRESERVE_SELECTOR.split(", "),
  paramsSchema: ThemeSchema,
  validate: () => null,
  apply(ctx, params) {
    if (params.value === "light") return applyCss(ctx, "theme", null);
    const themeFilter = params.value === "dark" ? "invert(1) hue-rotate(180deg)" : "none";
    // Root inversion flips light-scheme browser controls too; controls are then restored by the preserve rule.
    const colorScheme = "light";
    const cssParts = [
      `:root { --awl-theme-filter: ${themeFilter}; color-scheme: ${colorScheme} !important; ${filterChain} }`,
    ];
    if (params.value === "sepia") {
      cssParts.push("body { background-color: #f3ead7 !important; }");
      cssParts.push("body :is(main, article, [role='main']) { background-color: #fff8e8 !important; }");
      cssParts.push("body :is(h1, h2, h3, h4, h5, h6, p, li, blockquote, td, th) { color: #3b3428 !important; }");
      cssParts.push("body a { color: #755520 !important; }");
    }
    const marked: Array<{ element: Element; prior: string | null }> = [];
    if (params.value === "dark") {
      const selectors: string[] = [];
      if (typeof document !== "undefined") {
        const backgroundElements = Array.from(document.querySelectorAll("body *")).slice(0, 2500).filter((element) => {
          if (element.matches(APPEARANCE_PRESERVE_SELECTOR)) return false;
          try { return getComputedStyle(element).backgroundImage !== "none"; } catch { return false; }
        });
        const token = globalThis.crypto?.randomUUID?.() ?? Date.now().toString(36);
        backgroundElements.forEach((element, index) => {
          const value = `${token}-${index}`;
          marked.push({ element, prior: element.getAttribute("data-awl-bg-target") });
          element.setAttribute("data-awl-bg-target", value);
          selectors.push(`[data-awl-bg-target="${value}"]`);
        });
      }
      const preserve = [...selectors, REINVERT_SELECTOR].join(", ");
      cssParts.push(`${preserve} { filter: invert(1) hue-rotate(180deg) !important; }`);
    }
    const restore = () => marked.forEach(({ element, prior }) => {
      if (prior === null) element.removeAttribute("data-awl-bg-target");
      else element.setAttribute("data-awl-bg-target", prior);
    });
    return applyCss(ctx, "theme", cssParts.join("\n"), restore);
  },
};

export const appearanceOperations: Operation<unknown>[] = [
  themeOperation as Operation<unknown>,
  variableOperation("contrast", "Contrast", ContrastSchema, "contrast", 1) as Operation<unknown>,
  variableOperation("brightness", "Brightness", BrightnessSchema, "brightness", 1) as Operation<unknown>,
  variableOperation("saturation", "Saturation / grayscale", SaturationSchema, "saturation", 1) as Operation<unknown>,
];

export function registerAppearanceOps(): void {
  appearanceOperations.forEach(registerOperation);
}

export function appearancePlanSteps(prefs: AppearancePrefs, theme = prefs.theme) {
  return [
    { opId: "theme", params: { value: theme } },
    { opId: "contrast", params: { value: prefs.contrast } },
    { opId: "brightness", params: { value: prefs.brightness } },
    { opId: "saturation", params: { value: prefs.saturation } },
  ];
}

export const DEFAULT_APPEARANCE = AppearancePrefsSchema.parse({});
