import { describe, expect, it } from "vitest";
import { classifyDarkSignals, detectExistingDark, shouldSkipDarkTheme } from "../content/darkDetection";

describe("dark page signal classification", () => {
  it("recognizes explicit dark classes and color-scheme declarations", () => {
    expect(classifyDarkSignals({ darkClass: true, metaSchemeDark: false, cssSchemeDark: false, prefersDark: false, backgroundDark: false }).alreadyDark).toBe(true);
    expect(classifyDarkSignals({ darkClass: false, metaSchemeDark: true, cssSchemeDark: false, prefersDark: false, backgroundDark: false }).alreadyDark).toBe(true);
    expect(classifyDarkSignals({ darkClass: false, metaSchemeDark: false, cssSchemeDark: true, prefersDark: false, backgroundDark: false }).alreadyDark).toBe(true);
  });

  it("uses dark background luminance regardless of system preference", () => {
    expect(classifyDarkSignals({ darkClass: false, metaSchemeDark: false, cssSchemeDark: false, prefersDark: true, backgroundDark: true }).alreadyDark).toBe(true);
    expect(classifyDarkSignals({ darkClass: false, metaSchemeDark: false, cssSchemeDark: false, prefersDark: false, backgroundDark: true }).alreadyDark).toBe(true);
    expect(classifyDarkSignals({ darkClass: false, metaSchemeDark: false, cssSchemeDark: false, prefersDark: true, backgroundDark: false }).alreadyDark).toBe(false);
  });

  it("marks declared dark pages as explicit so Fast cannot double-invert them", () => {
    expect(classifyDarkSignals({ darkClass: true, metaSchemeDark: false, cssSchemeDark: false, prefersDark: false, backgroundDark: true }).explicitDark).toBe(true);
    expect(classifyDarkSignals({ darkClass: false, metaSchemeDark: false, cssSchemeDark: false, prefersDark: false, backgroundDark: true }).explicitDark).toBe(false);
  });

  it("skips an existing dark page only when Dark is the requested theme", () => {
    const status = classifyDarkSignals({ darkClass: true, metaSchemeDark: false, cssSchemeDark: false, prefersDark: false, backgroundDark: true });
    expect(shouldSkipDarkTheme("dark", status, false)).toBe(true);
    expect(shouldSkipDarkTheme("dark", status, true)).toBe(true);
    expect(shouldSkipDarkTheme("light", status, false)).toBe(false);
    expect(shouldSkipDarkTheme("sepia", status, false)).toBe(false);
  });

  it("does not treat a bright page as dark", () => {
    const result = classifyDarkSignals({ darkClass: false, metaSchemeDark: false, cssSchemeDark: false, prefersDark: false, backgroundDark: false });
    expect(result.alreadyDark).toBe(false);
    expect(result.signals).toEqual([]);
  });

  it("detects native-dark fixture signals and leaves a bright page classified as light", () => {
    const makePage = (dark: boolean) => {
      const selectorMatches = () => dark;
      const root = { matches: selectorMatches } as unknown as HTMLElement;
      const body = { matches: selectorMatches } as unknown as HTMLElement;
      const meta = dark ? { content: "dark" } as HTMLMetaElement : null;
      const doc = {
        documentElement: root,
        body,
        querySelector: () => meta,
      } as unknown as Document;
      const win = {
        getComputedStyle: () => ({ colorScheme: dark ? "dark" : "light", backgroundColor: dark ? "rgb(23, 25, 31)" : "rgb(250, 250, 250)" }),
        matchMedia: () => ({ matches: false }),
      } as unknown as Window;
      return detectExistingDark(doc, win);
    };
    expect(makePage(true).alreadyDark).toBe(true);
    expect(makePage(false).alreadyDark).toBe(false);
  });
});
