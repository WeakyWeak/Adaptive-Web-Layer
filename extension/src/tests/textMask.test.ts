import { describe, expect, it } from "vitest";
import { chunkText, splitSentences } from "../shared/chunk";
import { CODE_END, CODE_START, mask, stripCodeMarks, unmask } from "../shared/textMask";

const code = (text: string) => `${CODE_START}${text}${CODE_END}`;

describe("mask / unmask", () => {
  const source = `Run ${code("npm install monsoon-widget")} then call loadForecast() and set show_wind and API_KEY in user_settings.json. ` +
    "Data comes from https://api.monsoon.example.org/v2/forecast. Write to support@monsoon.example.org or see www.monsoon.example.org/help, " +
    "or pass --save and weatherPanel to the GitHub CLI.";

  it("replaces code, links, emails and identifiers with numbered placeholders", () => {
    const masked = mask(source);
    expect(masked.text).not.toMatch(/https?:|@|www\.|loadForecast|show_wind|API_KEY|user_settings|npm install|--save|weatherPanel|GitHub/);
    expect(masked.tokens).toEqual(expect.arrayContaining([
      "npm install monsoon-widget", "loadForecast()", "show_wind", "API_KEY", "user_settings.json",
      "https://api.monsoon.example.org/v2/forecast", "support@monsoon.example.org", "www.monsoon.example.org/help", "--save", "weatherPanel", "GitHub",
    ]));
    expect(masked.text).toContain("Data comes from [[");
  });

  it("round-trips exactly, keeping sentence punctuation outside URLs", () => {
    const masked = mask(source);
    expect(unmask(masked.text, masked.tokens)).toEqual({ text: stripCodeMarks(source), missing: [] });
  });

  it("restores placeholders a model or translator spaced out or wrote in Devanagari digits, and reports dropped ones", () => {
    const masked = mask("Copy API_KEY into user_settings.json now.");
    expect(unmask("कॉपी करें [[ 1 ]] को [[२]] में", masked.tokens).text).toBe("कॉपी करें API_KEY को user_settings.json में");
    expect(unmask("Only [[1]] survived.", masked.tokens).missing).toEqual([2]);
  });

  it("never lets page text that looks like a placeholder be confused with a real one", () => {
    const masked = mask("The template uses [[1]] as a slot, see example.com.");
    expect(unmask(masked.text, masked.tokens).text).toBe("The template uses [[1]] as a slot, see example.com.");
  });

  it("leaves ordinary prose alone", () => {
    const prose = "Raising it by 25 basis points, e.g. a quarter of one percentage point, sounds small. U.S. rates rose.";
    expect(mask(prose)).toEqual({ text: prose, tokens: [] });
  });
});

describe("chunkText", () => {
  const sentence = (index: number) => `Sentence number ${index} explains one small idea about the monsoon forecast service in plain words.`;
  const article = Array.from({ length: 12 }, (_, paragraph) => Array.from({ length: 6 }, (_, index) => sentence(paragraph * 6 + index)).join(" ")).join("\n\n");

  it("keeps every chunk within the limit and breaks only between sentences", () => {
    const chunks = chunkText(article, 2000);
    expect(chunks.length).toBeGreaterThan(3);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(2000);
      expect(chunk.trim().endsWith("words.")).toBe(true);
    }
    expect(chunks.join(" ").replace(/\s+/g, " ")).toBe(article.replace(/\s+/g, " "));
  });

  it("splits Hindi at the danda and an over-long sentence at word boundaries", () => {
    expect(splitSentences("पहला वाक्य। दूसरा वाक्य। तीसरा")).toEqual(["पहला वाक्य।", "दूसरा वाक्य।", "तीसरा"]);
    const long = Array.from({ length: 600 }, (_, index) => `word${index}`).join(" ");
    const chunks = chunkText(long, 500);
    expect(chunks.every((chunk) => chunk.length <= 500)).toBe(true);
    expect(chunks.join(" ")).toBe(long);
  });

  it("never splits a placeholder", () => {
    const masked = Array.from({ length: 300 }, (_, index) => `[[${index + 1}]]`).join(" ");
    for (const chunk of chunkText(masked, 120)) expect(chunk).toMatch(/^(\[\[\d+\]\] ?)+$/);
  });
});
