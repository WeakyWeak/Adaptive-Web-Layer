import React, { useEffect, useState } from "react";
import { defaultSettings, resolveAppearance, type AppearancePrefs } from "../../shared/settings";
import { withSiteRule } from "../../shared/sitePatch";
import { useSettings } from "../useSettings";

interface DetectionState { alreadyDark: boolean; explicitDark: boolean; signals: string[] }
const initialDetection: DetectionState = { alreadyDark: false, explicitDark: false, signals: [] };

export default function AppearancePanel(): React.ReactElement {
  const [settings, updateSettings] = useSettings();
  const [hostname, setHostname] = useState("");
  const [prefs, setPrefs] = useState<AppearancePrefs>(defaultSettings().global.appearance);
  const [detection, setDetection] = useState(initialDetection);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tabId = tabs[0]?.id;
      const url = tabs[0]?.url;
      if (url) setHostname(new URL(url).hostname.toLowerCase());
      if (tabId) chrome.tabs.sendMessage(tabId, { type: "GET_APPEARANCE_STATUS" }, (response) => {
        if (!chrome.runtime.lastError && response?.type === "APPEARANCE_STATUS") {
          setDetection({ alreadyDark: response.alreadyDark, explicitDark: response.explicitDark, signals: response.signals });
        }
      });
    });
  }, []);

  useEffect(() => {
    if (hostname) setPrefs(resolveAppearance(settings, hostname));
  }, [settings, hostname]);

  // Only appearance changes; everything else comes from the latest stored settings.
  const update = async (patch: Partial<AppearancePrefs>) => {
    if (!hostname) return;
    if (await updateSettings((current) => withSiteRule(current, hostname, (rule) => ({ ...rule, appearance: { ...rule.appearance, ...patch } })))) setSaved(true);
  };

  return (
    <div className="appearance-panel">
      <div className={`appearance-status ${detection.alreadyDark ? "already-dark" : ""}`} role="status">
        {detection.alreadyDark ? "Site already dark" : "Dark theme available"}
      </div>
      {detection.signals.length > 0 && <small className="appearance-signals">Detected: {detection.signals.join(", ")}</small>}
      <div className="theme-buttons" role="group" aria-label="Color theme">
        {(["light", "dark", "sepia"] as const).map((theme) => (
          <button key={theme} className={prefs.theme === theme ? "theme-selected" : ""} onClick={() => void update({ theme })}>{theme[0].toUpperCase() + theme.slice(1)}</button>
        ))}
      </div>
      <label className="appearance-engine">Engine<select value={prefs.engine} onChange={(event) => void update({ engine: event.target.value as AppearancePrefs["engine"] })}><option value="fast">Fast</option><option value="smart">Smart</option></select></label>
      <small className="appearance-signals">Smart adjusts page colors directly. Choose Light to turn a dark site into a light palette.</small>
      {detection.alreadyDark && !detection.explicitDark && prefs.theme === "dark" && (
        <label className="force-dark-option"><input type="checkbox" checked={prefs.forceDark} onChange={(event) => void update({ forceDark: event.target.checked })} /> Force dark anyway</label>
      )}
      <AppearanceSlider label="Contrast" value={prefs.contrast} min={0.5} max={2} step={0.1} onChange={(value) => void update({ contrast: value })} />
      <AppearanceSlider label="Brightness" value={prefs.brightness} min={0.5} max={1.5} step={0.1} onChange={(value) => void update({ brightness: value })} />
      <AppearanceSlider label="Saturation (0 = grayscale)" value={prefs.saturation} min={0} max={2} step={0.1} onChange={(value) => void update({ saturation: value })} />
      {saved && <small className="appearance-saved">✓ Saved for {hostname}</small>}
    </div>
  );
}

function AppearanceSlider({ label, value, min, max, step, onChange }: { label: string; value: number; min: number; max: number; step: number; onChange(value: number): void }): React.ReactElement {
  return <label className="appearance-slider"><span>{label}<strong>{value.toFixed(1)}</strong></span><input type="range" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} /></label>;
}
