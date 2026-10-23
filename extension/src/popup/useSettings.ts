import { useCallback, useEffect, useState } from "react";
import { defaultSettings, type Settings } from "../shared/settings";
import { loadSettings, onSettingsChange, patchSettings } from "../shared/storage";

/**
 * Live settings for a popup panel. `update` reads the latest stored settings
 * and applies `change` to them, so one panel never writes back another
 * panel's stale copy (Focus toggles used to undo an Appearance change).
 */
export function useSettings(): [Settings, (change: (current: Settings) => Settings) => Promise<boolean>] {
  const [settings, setSettings] = useState<Settings>(defaultSettings());
  useEffect(() => {
    void loadSettings().then(setSettings);
    const unsubscribe = onSettingsChange(setSettings);
    return () => { unsubscribe(); };
  }, []);
  const update = useCallback(async (change: (current: Settings) => Settings) => {
    setSettings((shown) => change(shown)); // show it at once; storage confirms below
    const next = await patchSettings(change);
    if (next) setSettings(next); else void loadSettings().then(setSettings);
    return next !== null;
  }, []);
  return [settings, update];
}
