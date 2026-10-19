import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)]);
}

describe("extension bundle secrets", () => {
  it("does not contain provider-key assignments", () => {
    const dist = join(process.cwd(), "dist");
    if (!existsSync(dist)) return;
    const bundle = files(dist).map((file) => readFileSync(file, "utf8")).join("\n");
    expect(bundle).not.toMatch(/GEMINI_API_KEY\s*=/);
    expect(bundle).not.toMatch(/SARVAM_API_KEY\s*=/);
    expect(bundle).not.toMatch(/AIza[A-Za-z0-9_-]{20,}/);
  });
});
