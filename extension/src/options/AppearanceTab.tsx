import React, { useEffect, useState, useCallback, useRef } from "react";
import type { TypographyPrefs } from "../shared/settings";
import { TypographyPrefsSchema } from "../shared/settings";
import { loadSettings, saveSettings } from "../shared/storage";
import { FONT_OPTIONS } from "../content/typographyOps";

const DEFAULT_PREFS: TypographyPrefs = TypographyPrefsSchema.parse({});

// Sample preview text
const PREVIEW_TEXT =
  "The quick brown fox jumps over the lazy dog. " +
  "Reading comfort matters for long-form content. " +
  "Adjust the sliders to find your ideal reading experience.";

export default function AppearanceTab(): React.ReactElement {
  const [prefs, setPrefs] = useState<TypographyPrefs>(DEFAULT_PREFS);
  const [saved, setSaved] = useState(false);
  const [loading, setLoading] = useState(true);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    loadSettings()
      .then((s) => { setPrefs(s.global.typography); setLoading(false); })
      .catch(() => setLoading(false));
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  // Send live preview to active tab
  const sendPreview = useCallback((p: TypographyPrefs) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (!tab?.id) return;
      chrome.tabs.sendMessage(tab.id, {
        type: "APPLY_TYPOGRAPHY",
        payload: p,
        applyToWholePage: false,
      }).catch(() => {/* tab may not have content script */});
    });
  }, []);

  const handleChange = useCallback(
    (key: keyof TypographyPrefs, value: TypographyPrefs[keyof TypographyPrefs]) => {
      const next = { ...prefs, [key]: value };
      setPrefs(next);
      setSaved(false);
      sendPreview(next);

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

  if (loading) return <div className="opt-loading">Loading settings…</div>;

  const previewStyle: React.CSSProperties = {
    fontFamily: prefs.fontFamily ? `"${prefs.fontFamily}", system-ui, sans-serif` : undefined,
    fontSize: `${prefs.fontSize}px`,
    lineHeight: prefs.lineHeight,
    letterSpacing: prefs.letterSpacing !== 0 ? `${prefs.letterSpacing}px` : undefined,
    wordSpacing: prefs.wordSpacing !== 0 ? `${prefs.wordSpacing}px` : undefined,
    marginBottom: prefs.paragraphSpacing !== 0 ? `${prefs.paragraphSpacing}em` : undefined,
    maxWidth: `${prefs.maxContentWidth}px`,
  };

  return (
    <div className="appearance-tab" id="appearance-tab">
      <div className="opt-section">
        <h3 className="opt-section-title">Typography</h3>
        <p className="opt-section-note">
          Note: dyslexia-friendly fonts (Lexend, Atkinson Hyperlegible) may help some readers —
          individual results vary.
        </p>

        <div className="opt-grid">
          {/* Font family */}
          <div className="opt-row">
            <label htmlFor="opt-font-family" className="opt-label">Font family</label>
            <select
              id="opt-font-family"
              className="opt-select"
              value={prefs.fontFamily}
              onChange={(e) => handleChange("fontFamily", e.target.value as TypographyPrefs["fontFamily"])}
            >
              {FONT_OPTIONS.map((f) => (
                <option key={f.value} value={f.value}>{f.label}</option>
              ))}
            </select>
          </div>

          {/* Font size */}
          <div className="opt-row">
            <label htmlFor="opt-font-size" className="opt-label">
              Font size <span className="opt-value">{prefs.fontSize}px</span>
            </label>
            <input
              id="opt-font-size"
              type="range" min={10} max={48} step={1}
              className="opt-slider"
              value={prefs.fontSize}
              onChange={(e) => handleChange("fontSize", Number(e.target.value))}
            />
          </div>

          {/* Line height */}
          <div className="opt-row">
            <label htmlFor="opt-line-height" className="opt-label">
              Line height <span className="opt-value">{prefs.lineHeight.toFixed(1)}</span>
            </label>
            <input
              id="opt-line-height"
              type="range" min={1} max={3} step={0.1}
              className="opt-slider"
              value={prefs.lineHeight}
              onChange={(e) => handleChange("lineHeight", Number(e.target.value))}
            />
          </div>

          {/* Letter spacing */}
          <div className="opt-row">
            <label htmlFor="opt-letter-spacing" className="opt-label">
              Letter spacing <span className="opt-value">{prefs.letterSpacing}px</span>
            </label>
            <input
              id="opt-letter-spacing"
              type="range" min={-2} max={10} step={0.5}
              className="opt-slider"
              value={prefs.letterSpacing}
              onChange={(e) => handleChange("letterSpacing", Number(e.target.value))}
            />
          </div>

          {/* Word spacing */}
          <div className="opt-row">
            <label htmlFor="opt-word-spacing" className="opt-label">
              Word spacing <span className="opt-value">{prefs.wordSpacing}px</span>
            </label>
            <input
              id="opt-word-spacing"
              type="range" min={-4} max={20} step={1}
              className="opt-slider"
              value={prefs.wordSpacing}
              onChange={(e) => handleChange("wordSpacing", Number(e.target.value))}
            />
          </div>

          {/* Paragraph spacing */}
          <div className="opt-row">
            <label htmlFor="opt-paragraph-spacing" className="opt-label">
              Paragraph gap <span className="opt-value">{prefs.paragraphSpacing.toFixed(1)}em</span>
            </label>
            <input
              id="opt-paragraph-spacing"
              type="range" min={0} max={5} step={0.25}
              className="opt-slider"
              value={prefs.paragraphSpacing}
              onChange={(e) => handleChange("paragraphSpacing", Number(e.target.value))}
            />
          </div>

          {/* Max content width */}
          <div className="opt-row">
            <label htmlFor="opt-max-width" className="opt-label">
              Max content width <span className="opt-value">{prefs.maxContentWidth}px</span>
            </label>
            <input
              id="opt-max-width"
              type="range" min={400} max={2000} step={50}
              className="opt-slider"
              value={prefs.maxContentWidth}
              onChange={(e) => handleChange("maxContentWidth", Number(e.target.value))}
            />
          </div>
        </div>

        <div className="opt-actions">
          <button id="opt-reset" className="opt-btn-reset" onClick={handleReset}>
            Reset to defaults
          </button>
          {saved && <span className="opt-saved">✓ Saved</span>}
        </div>
      </div>

      {/* Live preview area */}
      <div className="opt-section">
        <h3 className="opt-section-title">Preview</h3>
        <div className="opt-preview-wrap">
          <p className="opt-preview-text" style={previewStyle}>
            {PREVIEW_TEXT}
          </p>
          <p className="opt-preview-text" style={previewStyle}>
            Second paragraph: Lorem ipsum dolor sit amet, consectetur adipiscing elit.
            Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.
          </p>
        </div>
      </div>
    </div>
  );
}
