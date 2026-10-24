import React, { useEffect, useState, useCallback, useRef } from "react";
import type { Settings, TypographyPrefs } from "../../shared/settings";
import { DOUBLE_PARAGRAPH_SPACING, LETTER_SPACING_PRESETS, resolveTypography, TypographyPrefsSchema, WORD_SPACING_PRESETS } from "../../shared/settings";
import { withSiteTypography } from "../../shared/sitePatch";
import { loadSettings, patchSettings } from "../../shared/storage";
import { FONT_OPTIONS } from "../../content/typographyOps";
import { SpacingSelect, TEXT_SHAPE_TOGGLES } from "../../ui/readingControls";

const CLASSES = { row: "reading-row", label: "reading-label", value: "reading-value", select: "reading-select" };

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
        patchSettings((settings) => saveTypography(settings, hostname, next)).then((saved) => setSaved(saved !== null)).catch(console.warn);
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
    patchSettings((settings) => saveTypography(settings, hostname, defaults)).then((saved) => setSaved(saved !== null)).catch(console.warn);
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

      <SpacingSelect id="rp-letter-spacing" label="Letter spacing" value={prefs.letterSpacing} presets={LETTER_SPACING_PRESETS} classes={CLASSES} onChange={(value) => handleChange("letterSpacing", value)} />
      <SpacingSelect id="rp-word-spacing" label="Word spacing" value={prefs.wordSpacing} presets={WORD_SPACING_PRESETS} classes={CLASSES} onChange={(value) => handleChange("wordSpacing", value)} />

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
        <label className="reading-check">
          <input type="checkbox" checked={prefs.paragraphSpacing >= DOUBLE_PARAGRAPH_SPACING} onChange={(e) => handleChange("paragraphSpacing", e.target.checked ? DOUBLE_PARAGRAPH_SPACING : 0)} />
          Double paragraph spacing
        </label>
      </div>

      {TEXT_SHAPE_TOGGLES.map(([key, label]) => (
        <label key={key} className="reading-check">
          <input type="checkbox" checked={Boolean(prefs[key])} onChange={(e) => handleChange(key, e.target.checked)} />
          {label}
        </label>
      ))}

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
