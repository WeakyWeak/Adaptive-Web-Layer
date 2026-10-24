// ─── Reading-fit reader (P11) ────────────────────────────────────────────────
// An extension page shown in an iframe by the fit test. It renders one
// passage (text only, never HTML) and styles it with the same registry
// operations and applier the content script uses on real pages, so the
// settings that win here look the same on a site. It only talks to its parent
// page, which must be this extension; it makes no network requests.

import { z } from "zod";
import { applyAppearance, applyTypography } from "../content/applier";
import { registerAppearanceOps } from "../content/appearanceOps";
import { injectBundledFonts } from "../content/fontInjector";
import { getStyleLayer } from "../content/styleLayer";
import { registerTypographyOps } from "../content/typographyOps";
import { fitPrefs, FitSettingsSchema } from "../shared/fitTest";

export const RenderMessageSchema = z.object({
  type: z.literal("FIT_RENDER"),
  /** Echoed back in FIT_RENDERED (the parent uses the passage id plus the settings). */
  id: z.string().max(400),
  passage: z.object({ title: z.string().max(120), paragraphs: z.array(z.string().max(2000)).max(10) }),
  settings: FitSettingsSchema,
});

registerTypographyOps();
registerAppearanceOps();
const styleLayer = getStyleLayer();
injectBundledFonts(styleLayer);
const ctx = { styleLayer, applyToWholePage: false };

function render(message: z.infer<typeof RenderMessageSchema>): void {
  const article = document.getElementById("passage")!;
  const heading = document.createElement("h2");
  heading.textContent = message.passage.title;
  const paragraphs = message.passage.paragraphs.map((text) => {
    const paragraph = document.createElement("p");
    paragraph.textContent = text;
    return paragraph;
  });
  article.replaceChildren(heading, ...paragraphs);
  const { typography, appearance } = fitPrefs(message.settings);
  applyAppearance(ctx, appearance);
  applyTypography(ctx, typography);
}

window.addEventListener("message", (event) => {
  if (event.origin !== location.origin || event.source !== window.parent) return;
  const parsed = RenderMessageSchema.safeParse(event.data);
  if (!parsed.success) return;
  render(parsed.data);
  // Fonts finish loading before the reader starts timing.
  void document.fonts.ready.then(() => window.parent.postMessage({ type: "FIT_RENDERED", id: parsed.data.id }, location.origin));
});

window.parent.postMessage({ type: "FIT_READY" }, location.origin);
