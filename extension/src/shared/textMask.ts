// ─── Masking code, links and identifiers before text goes to a model ────────
// Each protected span becomes a numbered placeholder ([[1]], [[2]], …) that the
// model is told to copy as is; unmask puts the originals back. Code wrapped in
// CODE_START/CODE_END by the text extractor always becomes one placeholder.

export const CODE_START = "";
export const CODE_END = "";

const PATTERNS = [
  /\[\[\s*\d+\s*\]\]/.source,                                                // text that already looks like a placeholder
  `${CODE_START}[^${CODE_END}]*${CODE_END}`,                                  // inline code / code blocks from the extractor
  /\b(?:https?:\/\/|www\.)[^\s<>"'()]*[^\s<>"'().,;:!?]/.source,             // URLs
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.source,                   // emails
  /\b[A-Za-z_$][\w$]+(?:\.[A-Za-z_$][\w$]+)+(?:\(\))?/.source,               // dotted names: user.name, index.html, arr.map()
  /\b[A-Za-z_$][\w$]*\(\)/.source,                                           // calls: render()
  /\b[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+\b/.source,                       // snake_case, SCREAMING_CASE
  /\b[a-z]+(?:[A-Z][a-z0-9]*)+\b/.source,                                    // camelCase
  /\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+\b/.source,                            // PascalCase identifiers
  /(?<![\w-])--[a-z][\w-]*/.source,                                          // command-line flags
];
const MASKABLE = new RegExp(PATTERNS.join("|"), "g");
const PLACEHOLDER = /\[\[\s*([0-9०-९]+)\s*\]\]/g;
const DEVANAGARI_DIGITS = "०१२३४५६७८९";

export interface Masked {
  text: string;
  /** Originals, in placeholder order ([[1]] is tokens[0]). */
  tokens: string[];
}

export function mask(text: string): Masked {
  const tokens: string[] = [];
  const masked = text.replace(MASKABLE, (match) => {
    tokens.push(match.startsWith(CODE_START) ? match.slice(1, -1) : match);
    return `[[${tokens.length}]]`;
  });
  return { text: masked, tokens };
}

/** Puts originals back; lists placeholders the model dropped so the UI can say so. */
export function unmask(text: string, tokens: readonly string[]): { text: string; missing: number[] } {
  const used = new Set<number>();
  const restored = text.replace(PLACEHOLDER, (match, digits: string) => {
    const index = Number([...digits].map((digit) => DEVANAGARI_DIGITS.includes(digit) ? String(DEVANAGARI_DIGITS.indexOf(digit)) : digit).join(""));
    const original = tokens[index - 1];
    if (original === undefined) return match;
    used.add(index);
    return original;
  });
  const missing = tokens.map((_, index) => index + 1).filter((index) => !used.has(index));
  return { text: restored, missing };
}

/** Removes the extractor's code markers (for display or for text that is not masked). */
export function stripCodeMarks(text: string): string {
  return text.split(CODE_START).join("").split(CODE_END).join("");
}
