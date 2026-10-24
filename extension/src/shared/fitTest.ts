// ─── Reading-fit test (P11): the tournament, pure ───────────────────────────
// Each round shows one passage in one variant of the reader's settings and
// measures words per minute. Dimensions are tried in order; the winner of each
// carries forward. A wrong answer means the round does not count for speed;
// a speed difference under TIE_MARGIN is a tie, and ties go to what the
// reader said felt easier. Nothing here touches the network or a model.
//
// Evidence (docs/ARCHITECTURE.md): the best font differs per person (Wallace
// et al. 2022), extra letter spacing helps many dyslexic readers (Zorzi et al.
// 2012), larger text and warm backgrounds help (Rello & Baeza-Yates; Rello &
// Bigham 2017). Short tests are noisy: the result is a starting point.

import { z } from "zod";
import { FIT_PASSAGES, passageWords } from "./fitPassages";
import { AppearancePrefsSchema, FONT_FAMILY_OPTIONS, TypographyPrefsSchema, type AppearancePrefs, type NamedProfile, type TypographyPrefs } from "./settings";

export const FIT_BACKGROUNDS = ["white", "cream", "peach"] as const;

export const FitSettingsSchema = z.object({
  fontFamily: z.enum(FONT_FAMILY_OPTIONS),
  fontSize: z.number().min(10).max(48),
  letterSpacing: z.number().min(0).max(0.5),
  background: z.enum(FIT_BACKGROUNDS),
  lineHeight: z.number().min(1).max(3),
});
export type FitSettings = z.infer<typeof FitSettingsSchema>;

export const FIT_DIMENSIONS = ["fontFamily", "fontSize", "letterSpacing", "background", "lineHeight"] as const;
export type FitDimension = typeof FIT_DIMENSIONS[number];

export const BASELINE: FitSettings = { fontFamily: "", fontSize: 16, letterSpacing: 0, background: "white", lineHeight: 1.5 };

/** Candidates per dimension, the baseline value first. */
export const CANDIDATES: { [K in FitDimension]: ReadonlyArray<FitSettings[K]> } = {
  fontFamily: ["", "Lexend", "Atkinson Hyperlegible", "Verdana", "OpenDyslexic"],
  fontSize: [16, 18, 22],
  letterSpacing: [0, 0.12, 0.18],
  background: ["white", "cream", "peach"],
  lineHeight: [1.5, 1.8],
};

/** Steps up a scale: when one step loses, the bigger steps after it are not tried. */
const ORDERED: ReadonlySet<FitDimension> = new Set(["fontSize", "letterSpacing"]);

export const DIMENSION_LABEL: Record<FitDimension, string> = {
  fontFamily: "font",
  fontSize: "text size",
  letterSpacing: "letter spacing",
  background: "background",
  lineHeight: "line spacing",
};

/** Speeds this close (as a share) are a tie: short tests are noisy. */
export const TIE_MARGIN = 0.05;
/** Faster than this many ms means the passage was skipped, not read. */
export const MIN_READ_MS = 3000;
export const MAX_ROUNDS = FIT_PASSAGES.length;

export const RATINGS = ["easier", "same", "harder"] as const;
export type Rating = typeof RATINGS[number];

export const RoundResultSchema = z.object({
  passageId: z.string().max(32),
  settings: FitSettingsSchema,
  dimension: z.enum(FIT_DIMENSIONS),
  words: z.number().int().min(1),
  ms: z.number().min(0),
  correct: z.boolean(),
  /** Compared with the passage before (none for the first round). */
  rating: z.enum(RATINGS).nullable(),
});
export type RoundResult = z.infer<typeof RoundResultSchema>;

export interface Trial {
  round: number;
  dimension: FitDimension;
  settings: FitSettings;
  passage: typeof FIT_PASSAGES[number];
}

export function wordsPerMinute(words: number, ms: number): number {
  return ms > 0 ? Math.round((words / (ms / 60000)) * 10) / 10 : 0;
}

/** The speed a round counts for: null when the answer was wrong or the passage was skipped. */
export function countedWpm(round: Pick<RoundResult, "words" | "ms" | "correct">): number | null {
  return round.correct && round.ms >= MIN_READ_MS ? wordsPerMinute(round.words, round.ms) : null;
}

/** How easy each round felt, chained from the "easier / same / harder than the last one" answers. */
export function easeScores(rounds: readonly Pick<RoundResult, "rating">[]): number[] {
  const scores: number[] = [];
  rounds.forEach((round, index) => {
    const step = round.rating === "easier" ? 1 : round.rating === "harder" ? -1 : 0;
    scores.push(index === 0 ? 0 : scores[index - 1] + step);
  });
  return scores;
}

export interface Decision { dimension: FitDimension; challenger: number; incumbent: number; winner: "challenger" | "incumbent"; why: "faster" | "slower" | "tie-easier" | "tie-kept" | "wrong-answer" | "no-baseline" }

/** Challenger round vs incumbent round. */
export function decide(rounds: readonly RoundResult[], challenger: number, incumbent: number): Omit<Decision, "dimension"> {
  const ease = easeScores(rounds);
  const ch = countedWpm(rounds[challenger]);
  const inc = countedWpm(rounds[incumbent]);
  const base = { challenger, incumbent };
  if (ch === null && inc !== null) return { ...base, winner: "incumbent", why: "wrong-answer" };
  if (ch !== null && inc === null) return { ...base, winner: "challenger", why: "no-baseline" };
  if (ch !== null && inc !== null) {
    if (ch > inc * (1 + TIE_MARGIN)) return { ...base, winner: "challenger", why: "faster" };
    if (ch < inc * (1 - TIE_MARGIN)) return { ...base, winner: "incumbent", why: "slower" };
  }
  return ease[challenger] > ease[incumbent] ? { ...base, winner: "challenger", why: "tie-easier" } : { ...base, winner: "incumbent", why: "tie-kept" };
}

export interface Replay {
  best: FitSettings;
  /** Index of the round that best was measured in. */
  bestRound: number;
  decisions: Decision[];
  /** The next round to run, or null when the test is finished. */
  next: Trial | null;
}

/**
 * Replay the tournament over the rounds run so far: who won each comparison,
 * the settings carried forward, and the next round. Deterministic: the same
 * answers always give the same result.
 */
export function replay(rounds: readonly RoundResult[]): Replay {
  let best = { ...BASELINE };
  let bestRound = 0;
  const decisions: Decision[] = [];
  const trials: Array<{ dimension: FitDimension; settings: FitSettings }> = [{ dimension: "fontFamily", settings: { ...BASELINE } }];
  let index = 1;
  const nextTrial = (trial: { dimension: FitDimension; settings: FitSettings } | null): Replay => ({
    best, bestRound, decisions,
    next: trial && index < MAX_ROUNDS ? { round: index, ...trial, passage: FIT_PASSAGES[index] } : null,
  });
  if (rounds.length === 0) return { best, bestRound, decisions, next: { round: 0, ...trials[0], passage: FIT_PASSAGES[0] } };
  for (const dimension of FIT_DIMENSIONS) {
    for (const candidate of CANDIDATES[dimension]) {
      if (candidate === best[dimension]) continue;
      const settings = { ...best, [dimension]: candidate } as FitSettings;
      if (index >= rounds.length) return nextTrial({ dimension, settings });
      const decision = { dimension, ...decide(rounds, index, bestRound) };
      decisions.push(decision);
      if (decision.winner === "challenger") { best = settings; bestRound = index; }
      index++;
      if (decision.winner === "incumbent" && ORDERED.has(dimension)) break;
    }
  }
  return nextTrial(null);
}

// ── Result and profile ───────────────────────────────────────────────────────
export interface FitResult {
  best: FitSettings;
  rounds: number;
  /** Rounds that counted for speed (right answer, not skipped). */
  counted: number;
  baselineWpm: number | null;
  bestWpm: number | null;
  /** How much faster the best settings read than the starting settings; null when either round did not count. */
  fasterPercent: number | null;
  /** What changed from the starting settings, in words. */
  changes: string[];
}

export function describeSettings(settings: FitSettings): string[] {
  const lines: string[] = [];
  if (settings.fontFamily !== BASELINE.fontFamily) lines.push(`${settings.fontFamily} font`);
  if (settings.fontSize !== BASELINE.fontSize) lines.push(`${settings.fontSize}px text`);
  if (settings.letterSpacing !== BASELINE.letterSpacing) lines.push(`+${settings.letterSpacing}em letter spacing`);
  if (settings.background !== BASELINE.background) lines.push(`a ${settings.background} background`);
  if (settings.lineHeight !== BASELINE.lineHeight) lines.push(`${settings.lineHeight} line spacing`);
  return lines;
}

export function fitResult(rounds: readonly RoundResult[]): FitResult {
  const { best, bestRound } = replay(rounds);
  const baselineWpm = rounds.length ? countedWpm(rounds[0]) : null;
  const bestWpm = rounds.length ? countedWpm(rounds[bestRound]) : null;
  const fasterPercent = baselineWpm && bestWpm ? Math.round((bestWpm / baselineWpm - 1) * 100) : null;
  return {
    best,
    rounds: rounds.length,
    counted: rounds.filter((round) => countedWpm(round) !== null).length,
    baselineWpm,
    bestWpm,
    fasterPercent: bestRound === 0 ? 0 : fasterPercent,
    changes: describeSettings(best),
  };
}

/** The settings the reader and the saved profile both use, so the result transfers exactly. */
export function fitPrefs(settings: FitSettings): { typography: TypographyPrefs; appearance: AppearancePrefs } {
  return {
    typography: TypographyPrefsSchema.parse({ fontFamily: settings.fontFamily, fontSize: settings.fontSize, letterSpacing: settings.letterSpacing, lineHeight: settings.lineHeight }),
    appearance: AppearancePrefsSchema.parse({ backgroundTint: settings.background === "white" ? "none" : settings.background }),
  };
}

export const FIT_PROFILE_NOTE = "From your reading-fit test: a starting point, not a diagnosis. Retake it anytime.";

export function fitProfile(result: FitResult, id: string, name: string): NamedProfile {
  return { id, name, builtIn: false, ...fitPrefs(result.best), dyslexiaLens: true, note: FIT_PROFILE_NOTE };
}

// ── History (chrome.storage.local only, last 5 runs) ─────────────────────────
export const FIT_HISTORY_KEY = "awl_fit_history";
export const MAX_FIT_HISTORY = 5;

export const FitRunSchema = z.object({
  id: z.string().max(64),
  at: z.number(),
  rounds: z.array(RoundResultSchema).max(MAX_ROUNDS),
});
export type FitRun = z.infer<typeof FitRunSchema>;

export async function loadFitHistory(): Promise<FitRun[]> {
  try {
    const parsed = z.array(FitRunSchema).safeParse((await chrome.storage.local.get(FIT_HISTORY_KEY))[FIT_HISTORY_KEY]);
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

export async function saveFitRun(run: FitRun): Promise<FitRun[]> {
  const history = [run, ...(await loadFitHistory()).filter((item) => item.id !== run.id)].slice(0, MAX_FIT_HISTORY);
  await chrome.storage.local.set({ [FIT_HISTORY_KEY]: history });
  return history;
}

export async function deleteFitRun(id: string): Promise<FitRun[]> {
  const history = (await loadFitHistory()).filter((item) => item.id !== id);
  await chrome.storage.local.set({ [FIT_HISTORY_KEY]: history });
  return history;
}

export function roundWords(passageId: string): number {
  const passage = FIT_PASSAGES.find((item) => item.id === passageId);
  return passage ? passageWords(passage) : 1;
}
