// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildProseSelector, detectContentRegion, findContentRegion, getContentRegionSelector, MAIN_MARK, PROTECTED_ELEMENTS } from "../content/domUtils";

const paragraph = (words: number) => `<p>${"Readable article words go here. ".repeat(words)}</p>`;

// jsdom has no CSS.escape; ids in these tests need no escaping.
beforeAll(() => { if (!globalThis.CSS?.escape) Object.assign(globalThis, { CSS: { escape: (value: string) => value } }); });

describe("content region", () => {
  beforeEach(() => { document.body.innerHTML = ""; });
  afterEach(() => { document.body.innerHTML = ""; });

  it("uses <main> when it holds the prose", () => {
    document.body.innerHTML = `<header><p>Site name and a tagline here</p></header><main>${paragraph(20)}${paragraph(20)}</main>`;
    expect(detectContentRegion()).toBe("main");
  });

  it("picks the article that holds the prose, not the first one (listings, cards)", () => {
    document.body.innerHTML = `<article id="card"><p>A short teaser for another post</p></article><div><article class="post">${paragraph(20)}${paragraph(20)}</article></div>`;
    expect(findContentRegion()?.className).toBe("post");
  });

  it("finds the article on page-builder pages, with a selector unique to it", () => {
    // No main/article, and the header shares the article's first class (Elementor and similar builders).
    document.body.innerHTML = `
      <section class="elementor-element header"><nav><ul><li><a href="/">Services and more</a></li><li><a href="/w">Our work and clients</a></li></ul></nav></section>
      <section class="elementor-element hero"><h1>30 Bad Websites</h1></section>
      <div class="elementor-element layout">
        <div class="elementor-element post-content">${paragraph(15)}${paragraph(15)}${paragraph(15)}</div>
        <aside class="elementor-element sidebar"><p>Review our portfolio of sites</p></aside>
      </div>`;
    const selector = detectContentRegion();
    expect(selector).toBe(`[${MAIN_MARK}]`);
    expect(document.querySelectorAll(selector)).toHaveLength(1);
    expect(document.querySelector(selector)?.classList.contains("post-content")).toBe(true);
  });

  it("prefers a unique id, and moves the mark when the region changes", () => {
    document.body.innerHTML = `<div id="story">${paragraph(30)}${paragraph(30)}</div>`;
    expect(detectContentRegion()).toBe("#story");
    document.body.innerHTML = `<div class="a" ${MAIN_MARK}>old</div><div class="b"><div>${paragraph(30)}</div><div>${paragraph(30)}</div></div>`;
    expect(detectContentRegion()).toBe(`[${MAIN_MARK}]`);
    expect(document.querySelector(`[${MAIN_MARK}]`)?.className).toBe("b");
  });

  it("falls back to the whole page when there is little prose (galleries, apps)", () => {
    document.body.innerHTML = `<div class="grid"><div class="card">Alt.McAfee 1996</div><div class="card">Ty 1996</div></div>`;
    expect(detectContentRegion()).toBe("body");
  });

  it("does not count menus and link lists as prose", () => {
    const links = Array.from({ length: 30 }, (_, i) => `<li><a href="/${i}">A long navigation link number ${i}</a></li>`).join("");
    document.body.innerHTML = `<div class="menu"><ul>${links}</ul></div><div class="story">${paragraph(20)}</div>`;
    expect(findContentRegion()?.className).toBe("story");
  });

  it("re-detects when the cached region left the page", () => {
    document.body.innerHTML = `<div id="one">${paragraph(30)}</div>`;
    expect(getContentRegionSelector(false)).toBe("#one");
    document.body.innerHTML = `<div id="two">${paragraph(30)}</div>`;
    expect(getContentRegionSelector(false)).toBe("#two");
    expect(getContentRegionSelector(true)).toBe("body");
  });
});

describe("prose selectors", () => {
  it("excludes protected elements and their descendants from prose targets", () => {
    const selector = buildProseSelector("main");
    for (const tag of PROTECTED_ELEMENTS) {
      expect(selector).toContain(`:not(${tag})`);
      expect(selector).toContain(`:not(${tag} *)`);
    }
  });
});
