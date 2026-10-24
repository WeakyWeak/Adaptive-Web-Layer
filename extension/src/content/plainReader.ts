// ─── Plain reading view (P11) ────────────────────────────────────────────────
// The main content exactly as the page wrote it: headings, paragraphs, lists,
// quotes and code from the content region, in page order. No model, no
// summary, nothing rewritten. Navigation, sidebars, forms, hidden text and
// anything the reader has hidden (Clean this page) are left out.

import type { ReaderBlock } from "./readingView";

const BLOCKS = "h1, h2, h3, h4, h5, h6, p, ul, ol, blockquote, pre, dl, figcaption";
const SKIP = "nav, aside, form, button, select, textarea, script, style, noscript, template, [hidden], [aria-hidden='true'], [role='navigation'], [role='complementary'], [data-awl-overlay], [data-awl-picker]";
export const MAX_READER_BLOCKS = 600;

const collapse = (text: string) => text.replace(/\s+/g, " ").trim();
const shown = (element: Element) => {
  const check = (element as Element & { checkVisibility?: () => boolean }).checkVisibility;
  return typeof check === "function" ? check.call(element) : true;
};
const textOf = (element: Element) => collapse((element as HTMLElement).innerText ?? element.textContent ?? "");

function blockOf(element: Element): ReaderBlock | null {
  const tag = element.tagName.toLowerCase();
  if (/^h[1-6]$/.test(tag)) return { kind: "heading", text: textOf(element), items: [] };
  if (tag === "pre") return { kind: "code", text: (element.textContent ?? "").replace(/\s+$/, ""), items: [] };
  if (tag === "blockquote") return { kind: "quote", text: textOf(element), items: [] };
  if (tag === "ul" || tag === "ol") {
    const items = Array.from(element.children).filter((child) => child.tagName === "LI" && shown(child) && !child.matches(SKIP)).map(textOf).filter(Boolean);
    return { kind: "list", text: "", items, ordered: tag === "ol" };
  }
  if (tag === "dl") {
    const items = Array.from(element.children).filter((child) => /^D[TD]$/.test(child.tagName) && shown(child)).map(textOf).filter(Boolean);
    return { kind: "list", text: "", items };
  }
  return { kind: "paragraph", text: textOf(element), items: [] };
}

/** The readable blocks of `root`; the first h1 is left out when it is used as the title. */
export function readableBlocks(root: Element, skipTitle?: Element | null): ReaderBlock[] {
  const blocks: ReaderBlock[] = [];
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  for (let node = walker.nextNode() as Element | null; node && blocks.length < MAX_READER_BLOCKS;) {
    if (node.matches(SKIP) || !shown(node)) { node = nextOutside(walker, node); continue; }
    if (!node.matches(BLOCKS)) { node = walker.nextNode() as Element | null; continue; }
    const block = node === skipTitle ? null : blockOf(node);
    if (block && (block.text || block.items.length)) blocks.push(block);
    node = nextOutside(walker, node);
  }
  return blocks;
}

/** The next element after `node`'s whole subtree. */
function nextOutside(walker: TreeWalker, node: Element): Element | null {
  walker.currentNode = node;
  let next = walker.nextSibling();
  for (let parent: Node | null = node; !next && parent;) {
    parent = walker.parentNode();
    if (!parent) return null;
    next = walker.nextSibling();
  }
  return next as Element | null;
}

/** Title and blocks of the page's main content. */
export function plainReading(root: Element, doc: Document): { title: string; blocks: ReaderBlock[] } {
  const heading = root.querySelector("h1") ?? doc.querySelector("h1");
  const title = heading && shown(heading) ? textOf(heading) : doc.title;
  return { title: title || doc.title, blocks: readableBlocks(root, heading) };
}
