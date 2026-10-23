import React, { useEffect, useState, useCallback, useRef } from "react";
import type { Settings, TypographyPrefs } from "../../shared/settings";
import { resolveTypography, TypographyPrefsSchema } from "../../shared/settings";
import { withSiteTypography } from "../../shared/sitePatch";
import { loadSettings, saveSettings } from "../../shared/storage";
import { FONT_OPTIONS } from "../../content/typographyOps";

const DEFAULT_PREFS: TypographyPrefs = TypographyPrefsSchema.parse({});

/** Per-site when the tab is a web page; global otherwise. */
function saveTypography(settings: Settings, hostname: string, typography: TypographyPrefs): Settings {
  return hostname ? withSiteTypography(settings, hostname, typography) : { ...settings, global: { ...settings.global, typography } };
}

// ─── Reading panel ────────────────────────────────────────────────────────────
export default function ReadingPanel(): React.ReactElement {
  const [prefs, setPrefs] = useState<TypographyPrefs>(DEFAULT_PREFS);
  const [saved, setSaved] = useState(false);
  const [loading, setLoading] = useState(true);
  const [hostname, setHostname] = useState("");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load this site's resolved typography on mount. Changes are saved for this
  // site, like the other popup panels, so "Reset page" can undo all of them.
  useEffect(() => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      let host = "";
      try { host = new URL(tabs[0]?.url ?? "").hostname.toLowerCase(); } catch { /* not a web page */ }
      setHostname(host);
      loadSettings()
        .then((s) => {
          setPrefs(host ? resolveTypography(s, host) : s.global.typography);
          setLoading(false);
        })
        .catch(() => setLoading(false));
    });
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  // Send live preview to the active tab
  const sendPreview = useCallback((p: TypographyPrefs, applyToWholePage = false) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (!tab?.id) return;
      chrome.tabs.sendMessage(tab.id, {
        type: "APPLY_TYPOGRAPHY",
        payload: p,
        applyToWholePage,
      }).catch(() => {/* tab may not have content script */});
    });
  }, []);

  // Debounced live preview + save
  const handleChange = useCallback(
    (key: keyof TypographyPrefs, value: TypographyPrefs[keyof TypographyPrefs]) => {
      const next = { ...prefs, [key]: value };
      setPrefs(next);
      setSaved(false);

      // Immediate live preview
      sendPreview(next);

      // Debounced save to storage
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        loadSettings().then((settings) => saveSettings(saveTypography(settings, hostname, next))).then(setSaved).catch(console.warn);
      }, 600);
    },
    [prefs, sendPreview, hostname]
  );

  // Reset to defaults
  const handleReset = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = null;
    const defaults = TypographyPrefsSchema.parse({});
    setPrefs(defaults);
    sendPreview(defaults);
    loadSettings().then((settings) => saveSettings(saveTypography(settings, hostname, defaults))).then(setSaved).catch(console.warn);
  }, [sendPreview, hostname]);

  if (loading) return <div className="panel-loading">Loading…</div>;

  return (
    <div className="reading-panel" id="reading-panel">
      <div className="reading-row">
        <label htmlFor="rp-font-family" className="reading-label">Font</label>
        <select
          id="rp-font-family"
          className="reading-select"
          value={prefs.fontFamily}
          onChange={(e) => handleChange("fontFamily", e.target.value as TypographyPrefs["fontFamily"])}
        >
          {FONT_OPTIONS.map((f) => (
            <option key={f.value} value={f.value}>{f.label}</option>
          ))}
        </select>
      </div>

      <div className="reading-row">
        <label htmlFor="rp-font-size" className="reading-label">
          Size <span className="reading-value">{prefs.fontSize}px</span>
        </label>
        <input
          id="rp-font-size"
          type="range"
          min={10} max={48} step={1}
          className="reading-slider"
          value={prefs.fontSize}
          onChange={(e) => handleChange("fontSize", Number(e.target.value))}
        />
      </div>

      <div className="reading-row">
        <label htmlFor="rp-line-height" className="reading-label">
          Line height <span className="reading-value">{prefs.lineHeight.toFixed(1)}</span>
        </label>
        <input
          id="rp-line-height"
          type="range"
          min={1} max={3} step={0.1}
          className="reading-slider"
          value={prefs.lineHeight}
          onChange={(e) => handleChange("lineHeight", Number(e.target.value))}
        />
      </div>

      <div className="reading-row">
        <label htmlFor="rp-letter-spacing" className="reading-label">
          Letter spacing <span className="reading-value">{prefs.letterSpacing}px</span>
        </label>
        <input
          id="rp-letter-spacing"
          type="range"
          min={-2} max={10} step={0.5}
          className="reading-slider"
          value={prefs.letterSpacing}
          onChange={(e) => handleChange("letterSpacing", Number(e.target.value))}
        />
      </div>

      <div className="reading-row">
        <label htmlFor="rp-word-spacing" className="reading-label">
          Word spacing <span className="reading-value">{prefs.wordSpacing}px</span>
        </label>
        <input
          id="rp-word-spacing"
          type="range"
          min={-4} max={20} step={1}
          className="reading-slider"
          value={prefs.wordSpacing}
          onChange={(e) => handleChange("wordSpacing", Number(e.target.value))}
        />
      </div>

      <div className="reading-row">
        <label htmlFor="rp-paragraph-spacing" className="reading-label">
          Paragraph gap <span className="reading-value">{prefs.paragraphSpacing.toFixed(1)}em</span>
        </label>
        <input
          id="rp-paragraph-spacing"
          type="range"
          min={0} max={5} step={0.25}
          className="reading-slider"
          value={prefs.paragraphSpacing}
          onChange={(e) => handleChange("paragraphSpacing", Number(e.target.value))}
        />
      </div>

      <div className="reading-row">
        <label htmlFor="rp-max-width" className="reading-label">
          Max width <span className="reading-value">{prefs.maxContentWidth}px</span>
        </label>
        <input
          id="rp-max-width"
          type="range"
          min={400} max={2000} step={50}
          className="reading-slider"
          value={prefs.maxContentWidth}
          onChange={(e) => handleChange("maxContentWidth", Number(e.target.value))}
        />
      </div>

      <div className="reading-actions">
        <button
          id="rp-reset"
          className="btn-reset"
          onClick={handleReset}
        >
          Reset
        </button>
        {saved && <span className="reading-saved">✓ Saved{hostname ? ` for ${hostname}` : ""}</span>}
      </div>
    </div>
  );
}
