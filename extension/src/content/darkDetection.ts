import { isDarkCssColor, parseCssColor } from "../lib/color";

export interface DarkDetectionResult {
  alreadyDark: boolean;
  explicitDark: boolean;
  signals: string[];
}

export interface DarkSignals {
  darkClass: boolean;
  metaSchemeDark: boolean;
  cssSchemeDark: boolean;
  prefersDark: boolean;
  backgroundDark: boolean;
}

export function shouldSkipDarkTheme(
  theme: "light" | "dark" | "sepia",
  detection: DarkDetectionResult,
  forceDark: boolean,
  engine: "fast" | "smart" = "fast",
): boolean {
  // Only Fast uses inversion, which would turn an existing dark palette light.
  // Smart directly maps individual colors and is safe to evaluate on a dark page.
  return engine === "fast" && theme === "dark" && detection.alreadyDark && (!forceDark || detection.explicitDark);
}

export function classifyDarkSignals(input: DarkSignals): DarkDetectionResult {
  const signals: string[] = [];
  if (input.darkClass) signals.push("dark class or data attribute");
  if (input.metaSchemeDark) signals.push("color-scheme meta");
  if (input.cssSchemeDark) signals.push("CSS color-scheme");
  if (input.prefersDark) signals.push("prefers-color-scheme: dark");
  if (input.backgroundDark) signals.push("dark root or body background");
  const explicitDark = input.darkClass || input.metaSchemeDark || input.cssSchemeDark;
  // A dark root/body surface is enough to detect an already-dark site. Tying
  // this to the OS preference misses dark sites when the user's OS is light.
  return { alreadyDark: explicitDark || input.backgroundDark, explicitDark, signals };
}

export function detectExistingDark(doc: Document = document, win: Window = window): DarkDetectionResult {
  const root = doc.documentElement;
  const body = doc.body;
  if (!root) return classifyDarkSignals({ darkClass: false, metaSchemeDark: false, cssSchemeDark: false, prefersDark: false, backgroundDark: false });

  const darkSelector = ".dark, [data-theme='dark'], [data-color-scheme='dark'], [data-dark-mode='true']";
  const darkClass = root.matches(darkSelector) || Boolean(body?.matches(darkSelector));

  const metaScheme = doc.querySelector<HTMLMetaElement>('meta[name="color-scheme"]')?.content.toLowerCase().trim();
  const metaSchemeDark = metaScheme === "dark" || metaScheme === "only dark";

  const rootScheme = win.getComputedStyle(root).colorScheme.toLowerCase().trim();
  const bodyScheme = body ? win.getComputedStyle(body).colorScheme.toLowerCase().trim() : "";
  const cssSchemeDark = rootScheme === "dark" || bodyScheme === "dark";

  const prefersDark = win.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;

  const backgroundIsDark = [body, root].some((element) => {
    if (!element) return false;
    const background = win.getComputedStyle(element).backgroundColor;
    const parsed = parseCssColor(background);
    return parsed !== null && parsed.a > 0 && isDarkCssColor(background);
  });
  return classifyDarkSignals({ darkClass, metaSchemeDark, cssSchemeDark, prefersDark, backgroundDark: backgroundIsDark });
}
