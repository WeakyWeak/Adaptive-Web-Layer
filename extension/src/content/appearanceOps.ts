import { z } from "zod";
import { registerOperation, type Operation } from "../shared/registry";
import { AppearancePrefsSchema } from "../shared/settings";
import type { AppearancePrefs } from "../shared/settings";
import { APPEARANCE_PRESERVE_SELECTOR } from "./appearancePreserve";
import { createSmartPalette, type SmartPalette } from "./smartPalette";
import { setStyleEntry } from "./styleEntry";

export { APPEARANCE_PRESERVE_SELECTOR } from "./appearancePreserve";
const REINVERT_SELECTOR = ["img", "video", "canvas", "svg", "iframe", "pre", "code:not(pre code)", "kbd:not(pre kbd)", "samp:not(pre samp)", "input", "textarea", "select", "button", "[data-awl-preserve]"].join(", ");

const adjustmentFilters = "contrast(var(--awl-contrast, 1)) brightness(var(--awl-brightness, 1)) saturate(var(--awl-saturation, 1))";

const applyCss = setStyleEntry;

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
      const css = params.value === neutral ? null : `:root { --awl-${cssVariable}: ${params.value}${unit} !important; }`;
      return applyCss(ctx, id, css);
    },
  };
}

const ContrastSchema = z.object({ value: z.number().min(0.5).max(2) });
const BrightnessSchema = z.object({ value: z.number().min(0.5).max(1.5) });
const SaturationSchema = z.object({ value: z.number().min(0).max(2) });
const ThemeSchema = z.object({
  value: z.enum(["light", "dark", "sepia"]),
  engine: z.enum(["fast", "smart"]).optional(),
  skip: z.boolean().optional(),
  bodyReady: z.boolean().optional(),
});
const AppearanceFilterSchema = z.object({
  theme: z.enum(["light", "dark", "sepia"]),
  engine: z.enum(["fast", "smart"]),
  skip: z.boolean(),
  contrast: z.number().min(0.5).max(2),
  brightness: z.number().min(0.5).max(1.5),
  saturation: z.number().min(0).max(2),
});

const themeOperation: Operation<z.infer<typeof ThemeSchema>> = {
  id: "theme",
  label: "Color theme",
  target: "content-region",
  protectedElements: APPEARANCE_PRESERVE_SELECTOR.split(", "),
  paramsSchema: ThemeSchema,
  validate: () => null,
  apply(ctx, params) {
    const smart = (params.engine ?? "fast") === "smart";
    const skip = params.skip ?? false;
    // Fast dark filtering is emitted by the composed filter operation. This rule
    // only owns theme colors and Smart's direct palette overrides.
    const colorScheme = skip ? "" : smart && params.value !== "sepia"
      ? `color-scheme: ${params.value} !important;`
      : params.value === "dark" ? "color-scheme: light !important;" : "";
    const cssParts = [
      `:root { ${colorScheme} }`,
    ];
    if (params.value === "sepia") {
      cssParts.push("body { background-color: #f3ead7 !important; }");
      cssParts.push("body :is(main, article, [role='main']) { background-color: #fff8e8 !important; }");
      cssParts.push("body :is(h1, h2, h3, h4, h5, h6, p, li, blockquote, td, th) { color: #3b3428 !important; }");
      cssParts.push("body a { color: #755520 !important; }");
    }
    const marked: Array<{ element: Element; prior: string | null }> = [];
    let palette: SmartPalette | undefined;
    if (smart && !skip && params.value !== "sepia" && params.bodyReady && typeof document !== "undefined") {
      // Later batches (content rendered or restyled after this apply) rewrite the same entry.
      const base = cssParts.join("\n");
      palette = createSmartPalette(document, params.value, (css) => ctx.styleLayer.set("theme", [base, css].filter(Boolean).join("\n")));
      const css = palette.css();
      if (css) cssParts.push(css);
    }
    if (params.value === "dark" && !smart && !skip) {
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
    return applyCss(ctx, "theme", cssParts.join("\n"), () => { restore(); palette?.stop(); });
  },
};

const appearanceFilterOperation: Operation<z.infer<typeof AppearanceFilterSchema>> = {
  id: "appearanceFilter",
  label: "Appearance filter chain",
  target: "content-region",
  protectedElements: APPEARANCE_PRESERVE_SELECTOR.split(", "),
  paramsSchema: AppearanceFilterSchema,
  validate: () => null,
  apply(ctx, params) {
    const fastDark = params.theme === "dark" && params.engine === "fast" && !params.skip;
    const hasAdjustments = params.contrast !== 1 || params.brightness !== 1 || params.saturation !== 1;
    // `none` cannot be combined with other filter functions. Build the list here
    // instead of expanding a `none` custom property before contrast/brightness.
    const filters = [fastDark ? "invert(1) hue-rotate(180deg)" : "", adjustmentFilters].filter(Boolean).join(" ");
    const css = fastDark || hasAdjustments ? `:root { filter: ${filters} !important; }` : null;
    return applyCss(ctx, "appearanceFilter", css);
  },
};

export const appearanceOperations: Operation<unknown>[] = [
  themeOperation as Operation<unknown>,
  appearanceFilterOperation as Operation<unknown>,
  variableOperation("contrast", "Contrast", ContrastSchema, "contrast", 1) as Operation<unknown>,
  variableOperation("brightness", "Brightness", BrightnessSchema, "brightness", 1) as Operation<unknown>,
  variableOperation("saturation", "Saturation / grayscale", SaturationSchema, "saturation", 1) as Operation<unknown>,
];

export function registerAppearanceOps(): void {
  appearanceOperations.forEach(registerOperation);
}

export function appearancePlanSteps(
  prefs: AppearancePrefs,
  theme = prefs.theme,
  skipTheme = false,
  bodyReady = typeof document !== "undefined" && Boolean(document.body),
) {
  return [
    { opId: "theme", params: { value: theme, engine: prefs.engine, skip: skipTheme, bodyReady } },
    { opId: "contrast", params: { value: prefs.contrast } },
    { opId: "brightness", params: { value: prefs.brightness } },
    { opId: "saturation", params: { value: prefs.saturation } },
    { opId: "appearanceFilter", params: { theme, engine: prefs.engine, skip: skipTheme, contrast: prefs.contrast, brightness: prefs.brightness, saturation: prefs.saturation } },
  ];
}

export const DEFAULT_APPEARANCE = AppearancePrefsSchema.parse({});
