import { Settings, SettingsSchema, defaultSettings, migrateSettings } from "./settings";

const STORAGE_KEY = "awl_settings";

type ChangeListener = (settings: Settings) => void;
const listeners = new Set<ChangeListener>();

// ─── Read ─────────────────────────────────────────────────────────────────────
export async function loadSettings(): Promise<Settings> {
  try {
    const result = await chrome.storage.local.get(STORAGE_KEY);
    const raw = result[STORAGE_KEY];
    if (!raw || typeof raw !== "object") return defaultSettings();

    // Attempt migration + parse; fall back to defaults on any error
    try {
      return migrateSettings(raw as Record<string, unknown>);
    } catch {
      console.warn("[AWL storage] corrupt settings, resetting to defaults");
      return defaultSettings();
    }
  } catch (err) {
    console.warn("[AWL storage] load error, using defaults:", err);
    return defaultSettings();
  }
}

// ─── Write ────────────────────────────────────────────────────────────────────
export async function saveSettings(settings: Settings): Promise<boolean> {
  const parsed = SettingsSchema.safeParse(settings);
  if (!parsed.success) {
    console.warn("[AWL storage] refusing invalid settings:", parsed.error.flatten());
    return false;
  }
  try {
    await chrome.storage.local.set({ [STORAGE_KEY]: parsed.data });
    return true;
  } catch (error) {
    console.warn("[AWL storage] save error:", error);
    return false;
  }
}

// ─── Partial update ───────────────────────────────────────────────────────────
export async function patchSettings(
  patch: (current: Settings) => Settings
): Promise<Settings | null> {
  try {
    const current = await loadSettings();
    const next = patch(current);
    return await saveSettings(next) ? next : null;
  } catch (error) {
    console.warn("[AWL storage] settings update failed:", error);
    return null;
  }
}

// ─── Subscriptions ────────────────────────────────────────────────────────────
// Works in both background (always alive) and popup/options (short-lived).
export function onSettingsChange(listener: ChangeListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Listen to chrome.storage changes and fan out to subscribers
if (typeof chrome !== "undefined" && chrome.storage) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes[STORAGE_KEY]) return;
    const raw = changes[STORAGE_KEY].newValue;
    if (!raw) return;
    try {
      const settings = migrateSettings(raw as Record<string, unknown>);
      listeners.forEach((listener) => {
        try {
          listener(settings);
        } catch (error) {
          console.warn("[AWL storage] settings listener failed:", error);
        }
      });
    } catch {
      // ignore parse errors on storage events
    }
  });
}
