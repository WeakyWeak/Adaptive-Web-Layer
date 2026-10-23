// ─── Sentence-aware chunking ─────────────────────────────────────────────────
// Splits text into pieces of at most `maxChars`, breaking between paragraphs,
// then sentences, then words, so nothing (placeholders included) is cut midway.

const SENTENCE_END = /(?<=[.!?।॥])["'”’)]*\s+/;

export function splitSentences(paragraph: string): string[] {
  return paragraph.split(SENTENCE_END).map((sentence) => sentence.trim()).filter(Boolean);
}

function splitLong(piece: string, maxChars: number): string[] {
  const parts: string[] = [];
  let current = "";
  for (const word of piece.split(/\s+/)) {
    for (let start = 0; start < word.length; start += maxChars) {
      const fragment = word.slice(start, start + maxChars);
      const next = current ? `${current} ${fragment}` : fragment;
      if (next.length <= maxChars) current = next;
      else { parts.push(current); current = fragment; }
    }
  }
  if (current) parts.push(current);
  return parts;
}

export function chunkText(text: string, maxChars: number): string[] {
  const chunks: string[] = [];
  let current = "";
  const push = (piece: string, separator: string) => {
    const next = current ? `${current}${separator}${piece}` : piece;
    if (next.length <= maxChars) { current = next; return; }
    if (current) chunks.push(current);
    current = piece;
  };
  for (const paragraph of text.split(/\n\s*\n|\n/).map((item) => item.trim()).filter(Boolean)) {
    let separator = "\n\n";
    for (const sentence of splitSentences(paragraph)) {
      for (const piece of sentence.length > maxChars ? splitLong(sentence, maxChars) : [sentence]) {
        push(piece, separator);
        separator = " ";
      }
    }
  }
  if (current) chunks.push(current);
  return chunks;
}
