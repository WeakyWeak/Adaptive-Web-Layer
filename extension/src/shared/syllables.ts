// ─── English syllable counting (P11 dyslexia lens) ──────────────────────────
// Liang's hyphenation algorithm over the US English TeX patterns gives the
// break points inside a word. Every point the patterns allow is used (not
// only those typesetting would), and a piece without a vowel joins its
// neighbour ("p-re" → "pre"). Patterns are tuned to avoid bad line breaks, so
// they skip some syllables ("every", "idea"); the count is the larger of the
// pieces and the word's vowel groups.

import { EN_US_EXCEPTIONS, EN_US_PATTERNS } from "./hyphenEnUs";

interface Trie { points?: number[]; next: Map<string, Trie> }

let trie: Trie | null = null;
let exceptions: Map<string, number> | null = null;

function build(): Trie {
  const root: Trie = { next: new Map() };
  for (const pattern of EN_US_PATTERNS.split(/\s+/).filter(Boolean)) {
    const letters = pattern.replace(/\d/g, "");
    const points: number[] = [0];
    for (const char of pattern) {
      if (/\d/.test(char)) points[points.length - 1] = Number(char);
      else points.push(0);
    }
    let node = root;
    for (const letter of letters) {
      let child = node.next.get(letter);
      if (!child) { child = { next: new Map() }; node.next.set(letter, child); }
      node = child;
    }
    node.points = points;
  }
  return root;
}

/** Hyphenation pieces of a lower-case word ("information" → in, for, ma, tion). */
export function hyphenate(word: string): string[] {
  const lower = word.toLowerCase();
  exceptions ??= new Map(EN_US_EXCEPTIONS.split(/\s+/).filter(Boolean).map((entry) => [entry.replace(/-/g, ""), entry.split("-").length]));
  if (!/^[a-z]+$/.test(lower) || lower.length < 2) return [word];
  trie ??= build();
  const text = `.${lower}.`;
  const values = new Array<number>(text.length + 1).fill(0);
  for (let start = 0; start < text.length; start++) {
    let node: Trie | undefined = trie;
    for (let end = start; end < text.length && node; end++) {
      node = node.next.get(text[end]);
      node?.points?.forEach((value, offset) => { values[start + offset] = Math.max(values[start + offset], value); });
    }
  }
  const pieces: string[] = [];
  let piece = "";
  for (let index = 0; index < lower.length; index++) {
    piece += word[index];
    // An odd value after letter `index` is a break (values are offset by the leading dot).
    if (index < lower.length - 1 && values[index + 2] % 2 === 1) { pieces.push(piece); piece = ""; }
  }
  pieces.push(piece);
  // Every syllable has a vowel: a consonant-only piece joins the one before it (or after, at the start).
  return pieces.reduce<string[]>((joined, current) => {
    if (/[aeiouy]/i.test(current) || joined.length === 0) joined.push(current);
    else joined[joined.length - 1] += current;
    return joined;
  }, []).reduce<string[]>((joined, current, index) => {
    if (index === 1 && !/[aeiouy]/i.test(joined[0])) joined[0] += current;
    else joined.push(current);
    return joined;
  }, []);
}

const VOWEL_GROUPS = /[aeiouy]+/g;

/** Vowel groups, with a silent final "e" ("table" keeps its "le"). */
function vowelGroups(lower: string): number {
  const groups = (lower.match(VOWEL_GROUPS) ?? []).length;
  const silentE = /[^aeiouy]e$/.test(lower) && !/[^aeiouy]le$/.test(lower) && groups > 1 ? 1 : 0;
  return Math.max(1, groups - silentE);
}

/** Syllables in one English word; 0 for anything without letters. */
export function syllableCount(word: string): number {
  const lower = word.toLowerCase().replace(/[^a-z]/g, "");
  if (!lower) return 0;
  exceptions ??= new Map(EN_US_EXCEPTIONS.split(/\s+/).filter(Boolean).map((entry) => [entry.replace(/-/g, ""), entry.split("-").length]));
  const known = exceptions.get(lower);
  if (known) return known;
  return Math.max(hyphenate(lower).length, vowelGroups(lower));
}

/** Words of a text (letters and apostrophes; numbers and code are not words). */
export function wordsOf(text: string): string[] {
  return text.match(/[A-Za-z]+(?:'[A-Za-z]+)?/g) ?? [];
}

/** Share (0–1) of `words` with at least `min` syllables. */
export function longWordShare(words: readonly string[], min = 4): number {
  if (!words.length) return 0;
  return words.filter((word) => syllableCount(word) >= min).length / words.length;
}
