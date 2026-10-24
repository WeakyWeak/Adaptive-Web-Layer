// @vitest-environment jsdom
// P11 plain reading view: the main content as written, in page order, with
// no navigation, sidebars, forms, hidden text or extension UI.

import { describe, expect, it } from "vitest";
import { plainReading } from "../content/plainReader";

describe("plain reading view", () => {
  it("keeps headings, paragraphs, lists, quotes and code in order, exactly as written", () => {
    document.body.innerHTML = `
      <nav><a href="#">Home</a></nav>
      <main>
        <h1>River bends</h1>
        <p>Rivers   bend because
          water moves faster on the outside.</p>
        <aside>Related: 10 waterfalls</aside>
        <h2>Steps</h2>
        <ol><li>Erosion</li><li>Deposition</li><li hidden>Hidden step</li></ol>
        <blockquote>A quoted line.</blockquote>
        <div><div><p>Nested paragraph.</p></div></div>
        <pre>const x = 1;\n  return x;</pre>
        <form><p>Subscribe to our newsletter</p></form>
        <p hidden>Hidden text</p>
        <div data-awl-overlay="summary"><p>Our own card</p></div>
      </main>`;
    const { title, blocks } = plainReading(document.querySelector("main")!, document);
    expect(title).toBe("River bends");
    expect(blocks).toEqual([
      { kind: "paragraph", text: "Rivers bend because water moves faster on the outside.", items: [] },
      { kind: "heading", text: "Steps", items: [] },
      { kind: "list", text: "", items: ["Erosion", "Deposition"], ordered: true },
      { kind: "quote", text: "A quoted line.", items: [] },
      { kind: "paragraph", text: "Nested paragraph.", items: [] },
      { kind: "code", text: "const x = 1;\n  return x;", items: [] },
    ]);
  });

  it("uses the document title when the page has no h1", () => {
    document.title = "A page";
    document.body.innerHTML = `<main><p>Only a paragraph.</p></main>`;
    expect(plainReading(document.querySelector("main")!, document)).toEqual({ title: "A page", blocks: [{ kind: "paragraph", text: "Only a paragraph.", items: [] }] });
  });
});
