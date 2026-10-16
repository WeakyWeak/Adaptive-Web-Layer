import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultSettings } from "../shared/settings";
import { loadSettings, saveSettings } from "../shared/storage";

let storedSettings: unknown;
const storageGet = vi.fn(async () => ({ awl_settings: storedSettings }));
const storageSet = vi.fn(async (values: Record<string, unknown>) => {
  storedSettings = values.awl_settings;
});

describe("settings storage", () => {
  beforeEach(() => {
    storedSettings = undefined;
    storageGet.mockClear();
    storageSet.mockClear();
    vi.stubGlobal("chrome", {
      storage: {
        local: { get: storageGet, set: storageSet },
        onChanged: { addListener: vi.fn() },
      },
    });
  });

  it("persists validated settings and reloads them", async () => {
    const settings = defaultSettings();
    settings.global.typography.fontSize = 24;
    settings.siteRules = [{ hostname: "example.com", enabled: true, includeSubdomains: false, profileId: null, disabledOperations: [], typography: {}, appearance: { theme: "dark", forceDark: true } }];

    expect(await saveSettings(settings)).toBe(true);
    const loaded = await loadSettings();
    expect(loaded.global.typography.fontSize).toBe(24);
    expect(loaded.siteRules[0]?.appearance.theme).toBe("dark");
    expect(loaded.siteRules[0]?.appearance.forceDark).toBe(true);
  });

  it("rejects invalid writes without touching storage", async () => {
    const invalid = { ...defaultSettings(), global: { typography: { fontSize: 99 } } };

    expect(await saveSettings(invalid as ReturnType<typeof defaultSettings>)).toBe(false);
    expect(storageSet).not.toHaveBeenCalled();
  });

  it("returns defaults when storage cannot be read", async () => {
    vi.stubGlobal("chrome", {
      storage: {
        local: { get: vi.fn().mockRejectedValue(new Error("unavailable")), set: storageSet },
        onChanged: { addListener: vi.fn() },
      },
    });

    expect((await loadSettings()).global.typography.fontSize).toBe(16);
  });
});
