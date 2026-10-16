import { describe, expect, it, vi } from "vitest";
import { buildProseSelector, detectContentRegion, PROTECTED_ELEMENTS } from "../content/domUtils";

describe("content-region selectors", () => {
  it("prefers semantic landmarks in the documented order", () => {
    const querySelector = vi.fn((selector: string) => selector === "main" ? {} : null);
    vi.stubGlobal("document", { querySelector, querySelectorAll: vi.fn(() => []) });

    expect(detectContentRegion()).toBe("main");
    expect(querySelector).toHaveBeenCalledWith("main");
  });

  it("falls back to body when no landmark or dense region exists", () => {
    vi.stubGlobal("document", { querySelector: vi.fn(() => null), querySelectorAll: vi.fn(() => []) });

    expect(detectContentRegion()).toBe("body");
  });

  it("selects the highest text-density container when no semantic landmark exists", () => {
    const dense = {
      innerText: "Readable article content ".repeat(30),
      id: "article-body",
      className: "article content",
      tagName: "DIV",
      getBoundingClientRect: () => ({ width: 500, height: 300 }),
    };
    vi.stubGlobal("CSS", { escape: (value: string) => value });
    vi.stubGlobal("document", {
      querySelector: vi.fn(() => null),
      querySelectorAll: vi.fn(() => [dense]),
    });

    expect(detectContentRegion()).toBe("#article-body");
  });

  it("excludes protected elements and their descendants from prose targets", () => {
    const selector = buildProseSelector("main");

    for (const tag of PROTECTED_ELEMENTS) {
      expect(selector).toContain(`:not(${tag})`);
      expect(selector).toContain(`:not(${tag} *)`);
    }
  });
});
