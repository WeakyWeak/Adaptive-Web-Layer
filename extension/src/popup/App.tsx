import React, { useEffect, useState } from "react";
import type { PageInfo } from "../shared/messages";
import { panels } from "./panels/index";
import { defaultSettings, isSiteEnabled, matchingSiteRule, type Settings } from "../shared/settings";
import { loadSettings, saveSettings } from "../shared/storage";
import "./popup.css";

export default function App(): React.ReactElement {
  const [pageInfo, setPageInfo] = useState<PageInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [settings, setSettings] = useState<Settings>(defaultSettings());

  useEffect(() => {
    void loadSettings().then(setSettings);
    // Ask the active tab's content script for page info
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (!tab?.id) {
        setError("No active tab");
        return;
      }
      chrome.tabs.sendMessage(
        tab.id,
        { type: "GET_PAGE_INFO" },
        (response) => {
          if (chrome.runtime.lastError) {
            setError(chrome.runtime.lastError.message ?? "Content script unavailable");
            return;
          }
          if (response?.type === "PAGE_INFO" && response.payload) {
            setPageInfo(response.payload as PageInfo);
          } else {
            setError("Unexpected response");
          }
        }
      );
    });
  }, []);

  const updateRule = async (enabled: boolean) => {
    if (!pageInfo) return;
    const current = matchingSiteRule(settings, pageInfo.hostname);
    const next = { ...settings, siteRules: [...settings.siteRules.filter((r) => r.hostname !== pageInfo.hostname), { hostname: pageInfo.hostname.toLowerCase(), enabled, includeSubdomains: false, profileId: current?.profileId ?? null, disabledOperations: current?.disabledOperations ?? [], typography: current?.typography ?? {}, appearance: current?.appearance ?? {}, focus: current?.focus ?? {}, motion: current?.motion ?? {} }] };
    if (await saveSettings(next)) setSettings(next);
  };

  const resetSiteRule = async () => {
    if (!pageInfo) return;
    const next = { ...settings, siteRules: settings.siteRules.filter((rule) => rule.hostname !== pageInfo.hostname.toLowerCase()) };
    if (await saveSettings(next)) setSettings(next);
  };

  const sendPageAction = (type: "UNDO_PAGE" | "RESET_PAGE") => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]?.id) chrome.tabs.sendMessage(tabs[0].id, { type }).catch(() => undefined);
    });
  };

  return (
    <div className="popup-root">
      <header className="popup-header">
        <span className="popup-logo">⬡</span>
        <span className="popup-title">Adaptive Web Layer</span>
      </header>

      <section className="popup-status">
        {error ? (
          <div className="status-badge status-restricted">⚠ {error}</div>
        ) : pageInfo ? (
          <>
            <div className={`status-badge ${isSiteEnabled(settings, pageInfo.hostname) ? "status-active" : "status-restricted"}`}>{!settings.enabled ? "Global off" : isSiteEnabled(settings, pageInfo.hostname) ? `Active${(() => { const id = matchingSiteRule(settings, pageInfo.hostname)?.profileId ?? settings.activeProfileId; return id ? `: ${settings.profiles.find((p) => p.id === id)?.name ?? "Custom"}` : ""; })()}` : "Off on this site"}</div>
            <div className="page-info">
              <span className="page-hostname">{pageInfo.hostname}</span>
            </div>
            <button className="site-toggle" onClick={() => void updateRule(!isSiteEnabled(settings, pageInfo.hostname))}>{isSiteEnabled(settings, pageInfo.hostname) ? "Turn off on this site" : "Turn on for this site"}</button>
            {matchingSiteRule(settings, pageInfo.hostname) && <button className="site-reset" onClick={() => void resetSiteRule()}>Reset this site’s rule</button>}
            <label className="global-toggle"><input type="checkbox" checked={settings.enabled} onChange={(e) => { const next = { ...settings, enabled: e.target.checked }; void saveSettings(next).then((ok) => { if (ok) setSettings(next); }); }} /> Enable Adaptive Web Layer globally</label>
            <label className="profile-select">Profile <select value={settings.activeProfileId ?? ""} onChange={(e) => { const next = { ...settings, activeProfileId: e.target.value || null }; void saveSettings(next).then((ok) => { if (ok) setSettings(next); }); }}><option value="">None</option>{settings.profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
            <div className="page-actions"><button onClick={() => sendPageAction("UNDO_PAGE")}>Undo</button><button onClick={() => sendPageAction("RESET_PAGE")}>Reset page</button></div>
          </>
        ) : (
          <div className="status-badge status-loading">Loading…</div>
        )}
      </section>

      {/* Panels are registered by feature phase. */}
      {panels.length > 0 && (
        <section className="popup-panels">
          {panels.map(({ id, title, Component }) => (
            <details key={id} className="panel-item">
              <summary className="panel-title">{title}</summary>
              <div className="panel-body">
                <Component />
              </div>
            </details>
          ))}
        </section>
      )}

      <footer className="popup-footer">
        <button
          className="btn-options"
          onClick={() => chrome.runtime.openOptionsPage()}
        >
          Settings
        </button>
      </footer>
    </div>
  );
}
