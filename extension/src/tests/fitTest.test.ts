// P11 reading-fit test: words-per-minute maths, wrong answers excluded from
// speed, a deterministic tournament for a scripted run, result → profile →
// the same settings on a page, the 5-run history, and no network at all.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FIT_PASSAGES, passageWords } from "../shared/fitPassages";
import {
  BASELINE,
  countedWpm,
  decide,
  deleteFitRun,
  easeScores,
  fitPrefs,
  fitProfile,
  fitResult,
  loadFitHistory,
  MAX_FIT_HISTORY,
  MAX_ROUNDS,
  replay,
  saveFitRun,
  wordsPerMinute,
  type FitSettings,
  type Rating,
  type RoundResult,
} from "../shared/fitTest";
import { defaultSettings, resolveAppearance, resolveTypography } from "../shared/settings";

const round = (settings: FitSettings, wpm: number, correct = true, rating: Rating | null = "same", words = 120): RoundResult => ({
  passageId: "p", settings, dimension: "fontFamily", words, ms: Math.round((words / wpm) * 60000), correct, rating,
});

/**
 * A scripted reader: reads at `speedOf(settings)` words a minute, answers
 * right unless `wrong(round)` says so, and rates ease from `feel`.
 */
function scriptedRun(speedOf: (settings: FitSettings) => number, wrong: (index: number) => boolean = () => false, feel: (index: number) => Rating = () => "same"): RoundResult[] {
  const rounds: RoundResult[] = [];
  for (let next = replay(rounds).next; next; next = replay(rounds).next) {
    const words = passageWords(next.passage);
    rounds.push({ passageId: next.passage.id, settings: next.settings, dimension: next.dimension, words, ms: Math.round((words / speedOf(next.settings)) * 60000), correct: !wrong(next.round), rating: next.round === 0 ? null : feel(next.round) });
  }
  return rounds;
}

describe("speed", () => {
  it("computes words per minute", () => {
    expect(wordsPerMinute(120, 60000)).toBe(120);
    expect(wordsPerMinute(100, 40000)).toBe(150);
    expect(wordsPerMinute(110, 0)).toBe(0);
  });

  it("does not count a wrong answer or a skipped passage", () => {
    expect(countedWpm({ words: 120, ms: 48000, correct: true })).toBe(150);
    expect(countedWpm({ words: 120, ms: 48000, correct: false })).toBeNull();
    expect(countedWpm({ words: 120, ms: 1500, correct: true })).toBeNull();
  });

  it("a challenger with a wrong answer never wins on speed", () => {
    const rounds = [round(BASELINE, 100, true, null), round({ ...BASELINE, fontFamily: "Lexend" }, 200, false, "easier")];
    expect(decide(rounds, 1, 0)).toMatchObject({ winner: "incumbent", why: "wrong-answer" });
  });

  it("calls small differences a tie and gives ties to the stated preference", () => {
    const easier = [round(BASELINE, 100, true, null), round({ ...BASELINE, fontFamily: "Lexend" }, 103, true, "easier")];
    expect(decide(easier, 1, 0)).toMatchObject({ winner: "challenger", why: "tie-easier" });
    const harder = [round(BASELINE, 100, true, null), round({ ...BASELINE, fontFamily: "Lexend" }, 103, true, "harder")];
    expect(decide(harder, 1, 0)).toMatchObject({ winner: "incumbent", why: "tie-kept" });
    expect(easeScores([{ rating: null }, { rating: "easier" }, { rating: "harder" }, { rating: "easier" }])).toEqual([0, 1, 0, 1]);
  });
});

describe("tournament", () => {
  // This reader is fastest with Atkinson, 22px, 0.12em spacing, cream, 1.8 line height.
  const speedOf = (settings: FitSettings) => 100
    + (settings.fontFamily === "Atkinson Hyperlegible" ? 30 : settings.fontFamily === "OpenDyslexic" ? -10 : 0)
    + (settings.fontSize === 18 ? 15 : settings.fontSize === 22 ? 25 : 0)
    + (settings.letterSpacing === 0.12 ? 12 : settings.letterSpacing === 0.18 ? 4 : 0)
    + (settings.background === "cream" ? 10 : 0)
    + (settings.lineHeight === 1.8 ? 10 : 0);

  it("is deterministic and finds the scripted reader's best settings", () => {
    const first = scriptedRun(speedOf);
    expect(scriptedRun(speedOf)).toEqual(first);
    expect(first.length).toBeLessThanOrEqual(MAX_ROUNDS);
    // Every round uses a different passage.
    expect(new Set(first.map((item) => item.passageId)).size).toBe(first.length);
    expect(replay(first).best).toEqual({ fontFamily: "Atkinson Hyperlegible", fontSize: 22, letterSpacing: 0.12, background: "cream", lineHeight: 1.8 });
    const result = fitResult(first);
    expect(result.fasterPercent).toBe(Math.round(((100 + 30 + 25 + 12 + 10 + 10) / 100 - 1) * 100));
    expect(result.changes).toEqual(["Atkinson Hyperlegible font", "22px text", "+0.12em letter spacing", "a cream background", "1.8 line spacing"]);
  });

  it("stops climbing a scale when a step loses, and runs 10 to 12 rounds", () => {
    const flat = scriptedRun(() => 120);
    // Nothing is faster: 4 fonts, one size step, one spacing step, 2 backgrounds, 1 line height, plus the start.
    expect(flat).toHaveLength(10);
    expect(flat.filter((item) => item.dimension === "fontSize")).toHaveLength(1);
    expect(replay(flat).best).toEqual(BASELINE);
    expect(scriptedRun(speedOf).length).toBe(12);
  });

  it("keeps the incumbent when the challenger's answer is wrong, even if it was faster", () => {
    // Round 2 (Atkinson) is answered wrongly: it cannot win.
    const rounds = scriptedRun(speedOf, (index) => index === 2);
    expect(replay(rounds).best.fontFamily).toBe("");
  });

  it("uses the reader's feeling to break ties", () => {
    const rounds = scriptedRun(() => 120, () => false, (index) => (index === 1 ? "easier" : "same"));
    expect(replay(rounds).best.fontFamily).toBe("Lexend");
  });
});

describe("result → profile", () => {
  const result = fitResult(scriptedRun((settings) => (settings.fontFamily === "Verdana" ? 150 : 100) + (settings.background === "peach" ? 20 : 0)));

  it("turns the winner into a named profile with the lens on and honest wording", () => {
    const profile = fitProfile(result, "fit-1", "My reading settings");
    expect(profile.typography).toMatchObject({ fontFamily: "Verdana", fontSize: 16, letterSpacing: 0, lineHeight: 1.5 });
    expect(profile.appearance.backgroundTint).toBe("peach");
    expect(profile.dyslexiaLens).toBe(true);
    expect(profile.note).toMatch(/not a diagnosis/);
  });

  it("applies on a site exactly as the reader showed it", () => {
    const profile = fitProfile(result, "fit-1", "Mine");
    const settings = { ...defaultSettings(), profiles: [...defaultSettings().profiles, profile], activeProfileId: "fit-1" };
    const shown = fitPrefs(result.best);
    expect(resolveTypography(settings, "example.com")).toEqual(shown.typography);
    expect(resolveAppearance(settings, "example.com")).toEqual(shown.appearance);
  });
});

function memoryArea() {
  const data: Record<string, unknown> = {};
  return {
    data,
    get: vi.fn(async (key: string) => ({ [key]: structuredClone(data[key]) })),
    set: vi.fn(async (values: Record<string, unknown>) => { Object.assign(data, structuredClone(values)); }),
  };
}

describe("history and privacy", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    vi.stubGlobal("XMLHttpRequest", vi.fn());
    vi.stubGlobal("chrome", { storage: { local: memoryArea() }, runtime: { sendMessage: vi.fn() } });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("keeps the last 5 runs locally, each deletable, and never uses the network", async () => {
    const rounds = scriptedRun(() => 120);
    for (let index = 0; index < 7; index++) await saveFitRun({ id: `run-${index}`, at: index, rounds });
    let history = await loadFitHistory();
    expect(history.map((run) => run.id)).toEqual(["run-6", "run-5", "run-4", "run-3", "run-2"]);
    expect(history).toHaveLength(MAX_FIT_HISTORY);
    history = await deleteFitRun("run-4");
    expect(history.map((run) => run.id)).toEqual(["run-6", "run-5", "run-3", "run-2"]);
    fitResult(history[0].rounds);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it("the test's code has no network or messaging calls at all", () => {
    for (const file of ["shared/fitTest.ts", "shared/fitPassages.ts", "fit/FitTest.tsx", "fit/FitReader.tsx", "fit/FitResultView.tsx", "fitreader/main.ts"]) {
      const source = readFileSync(resolve(__dirname, "..", file), "utf8");
      expect(source, file).not.toMatch(/\bfetch\(|XMLHttpRequest|WebSocket|sendBeacon|runtime\.sendMessage|tabs\.sendMessage/);
    }
  });

  it("uses only its own passages: twelve, each with a question whose answer is one of the options", () => {
    expect(FIT_PASSAGES).toHaveLength(12);
    for (const passage of FIT_PASSAGES) {
      expect(passageWords(passage), passage.id).toBeGreaterThanOrEqual(95);
      expect(passageWords(passage), passage.id).toBeLessThanOrEqual(140);
      expect(passage.question.options[passage.question.answer]).toBeTruthy();
    }
  });
});
