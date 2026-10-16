import React, { useEffect, useState, useCallback, useRef } from "react";
import type { TypographyPrefs } from "../../shared/settings";
import { TypographyPrefsSchema } from "../../shared/settings";
import { loadSettings, saveSettings } from "../../shared/storage";
import { FONT_OPTIONS } from "../../content/typographyOps";

const DEFAULT_PREFS: TypographyPrefs = TypographyPrefsSchema.parse({});

// ─── Reading panel ────────────────────────────────────────────────────────────
export default function ReadingPanel(): React.ReactElement {
  const [prefs, setPrefs] = useState<TypographyPrefs>(DEFAULT_PREFS);
  const [saved, setSaved] = useState(false);
  const [loading, setLoading] = useState(true);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load current settings on mount
  useEffect(() => {
    loadSettings()
      .then((s) => {
        setPrefs(s.global.typography);
        setLoading(false);
      })
      .catch(() => setLoading(false));
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
        loadSettings().then((settings) => {
          const updated = {
            ...settings,
            global: { ...settings.global, typography: next },
          };
          return saveSettings(updated);
        }).then(setSaved).catch(console.warn);
      }, 600);
    },
    [prefs, sendPreview]
  );

  // Reset to defaults
  const handleReset = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = null;
    const defaults = TypographyPrefsSchema.parse({});
    setPrefs(defaults);
    sendPreview(defaults);
    loadSettings().then((settings) => {
      const updated = {
        ...settings,
        global: { ...settings.global, typography: defaults },
      };
      return saveSettings(updated);
    }).then(setSaved).catch(console.warn);
  }, [sendPreview]);

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
        {saved && <span className="reading-saved">✓ Saved</span>}
      </div>
    </div>
  );
}
