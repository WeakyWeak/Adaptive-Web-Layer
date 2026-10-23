// ─── Translation languages (registry) ────────────────────────────────────────
// English → Hindi only for now; adding a language is one entry here and one in
// the proxy's allow-list (server/src/providers/sarvam.ts).

export interface Language { code: string; name: string; nativeName: string }

export const SOURCE_LANGUAGE = "en-IN";
export const TARGET_LANGUAGES: readonly Language[] = [
  { code: "hi-IN", name: "Hindi", nativeName: "हिन्दी" },
];
export const DEFAULT_TARGET = "hi-IN";
export const TARGET_CODES = TARGET_LANGUAGES.map((language) => language.code) as [string, ...string[]];

/** Sarvam's per-request input limit for sarvam-translate:v1 (docs.sarvam.ai, Translate Text). */
export const TRANSLATE_CHUNK_CHARS = 2000;

export function languageName(code: string): string {
  const language = TARGET_LANGUAGES.find((item) => item.code === code);
  return language ? `${language.name} (${language.nativeName})` : code;
}

/**
 * Sarvam's data handling as published (docs.sarvam.ai "Data retention" and
 * sarvam.ai terms, checked 2026-10-23). Shown wherever translation is offered.
 */
export const SARVAM_NOTICE = "Translation uses Sarvam (cloud). Sarvam keeps workspace data until the workspace owner sets a retention period (0 days is available for model APIs in the Sarvam dashboard), and its terms say identifiable content is not used for training without opt-in.";
