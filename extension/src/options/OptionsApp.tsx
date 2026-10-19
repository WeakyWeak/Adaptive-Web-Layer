import React, { useEffect, useState } from "react";
import "./options.css";
import AppearanceTab from "./AppearanceTab";
import AiTab from "./AiTab";
import PrivacyTab from "./PrivacyTab";
import { defaultSettings, SettingsSchema, BUILT_IN_PROFILES, resolveAppearance, resolveFocus, resolveMotion, resolveTypography, type Settings } from "../shared/settings";
import { loadSettings, saveSettings } from "../shared/storage";

const TABS = [
  { id: "appearance", label: "Appearance & Reading" },
  { id: "profiles", label: "Profiles" },
  { id: "sites", label: "Sites" },
  { id: "ai", label: "AI" },
  { id: "privacy", label: "Privacy & Consent" },
  { id: "import-export", label: "Import/Export" },
  { id: "troubleshooting", label: "Troubleshooting" },
] as const;

type TabId = (typeof TABS)[number]["id"];

export default function OptionsApp(): React.ReactElement {
  const [activeTab, setActiveTab] = useState<TabId>("appearance");
  const [settings, setSettings] = useState<Settings>(defaultSettings());
  const [message, setMessage] = useState("");
  const [siteHost, setSiteHost] = useState("");
  const [importMode, setImportMode] = useState<"merge" | "replace">("replace");
  useEffect(() => { void loadSettings().then(setSettings); }, []);
  const update = async (next: Settings) => {
    if (await saveSettings(next)) { setSettings(next); setMessage("Saved"); }
    else setMessage("Could not save settings");
  };
  const clearAll = async () => {
    await chrome.storage.local.clear();
    setSettings(defaultSettings());
    setMessage("All extension data and caches cleared");
  };

  return (
    <div className="options-root">
      <header className="options-header">
        <span className="options-logo">⬡</span>
        <h1 className="options-title">Adaptive Web Layer — Settings</h1>
      </header>

      <div className="options-body">
        <nav className="options-nav">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              id={`tab-${tab.id}`}
              className={`nav-tab ${activeTab === tab.id ? "nav-tab-active" : ""}`}
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </nav>

        <main className="options-content">
          {activeTab === "appearance" ? <AppearanceTab /> : activeTab === "ai" ? <AiTab settings={settings} update={update} /> : activeTab === "privacy" ? <PrivacyTab settings={settings} update={update} clear={clearAll} /> : activeTab === "profiles" ? (
            <section className="tab-panel"><h2 className="tab-heading">Profiles</h2>
              <button onClick={() => void update({ ...settings, profiles: [...settings.profiles, { id: crypto.randomUUID(), name: "New profile", typography: settings.global.typography, appearance: settings.global.appearance, focus: settings.global.focus, motion: settings.global.motion, builtIn: false }] })}>Create profile</button>
              <button onClick={() => chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => { const hostname = tabs[0]?.url ? new URL(tabs[0].url).hostname : ""; const typography = hostname ? resolveTypography(settings, hostname) : settings.global.typography; const appearance = hostname ? resolveAppearance(settings, hostname) : settings.global.appearance; const focus = hostname ? resolveFocus(settings, hostname) : settings.global.focus; const motion = hostname ? resolveMotion(settings, hostname) : settings.global.motion; void update({ ...settings, profiles: [...settings.profiles, { id: crypto.randomUUID(), name: "Saved current settings", typography, appearance, focus, motion, builtIn: false }] }); })}>Save current page settings as profile</button>
              <label>Active profile <select value={settings.activeProfileId ?? ""} onChange={(e) => void update({ ...settings, activeProfileId: e.target.value || null })}><option value="">None</option>{settings.profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
              {settings.profiles.map((p) => <div className="profile-row" key={p.id}><input aria-label="Profile name" value={p.name} onChange={(e) => void update({ ...settings, profiles: settings.profiles.map((x) => x.id === p.id ? { ...x, name: e.target.value } : x) })} />{p.builtIn && <span>Built-in</span>}<button onClick={() => void update({ ...settings, profiles: [...settings.profiles, { ...p, id: crypto.randomUUID(), name: `${p.name} copy`, builtIn: false }] })}>Duplicate</button><button disabled={p.builtIn} onClick={() => void update({ ...settings, profiles: settings.profiles.filter((x) => x.id !== p.id), activeProfileId: settings.activeProfileId === p.id ? null : settings.activeProfileId })}>Delete</button></div>)}
              <small>Presets: {BUILT_IN_PROFILES.map((p) => p.name).join(", ")}</small>
            </section>
          ) : activeTab === "sites" ? (
            <section className="tab-panel"><h2 className="tab-heading">Sites</h2>
              <label>New hostname <input value={siteHost} onChange={(e) => setSiteHost(e.target.value)} placeholder="example.com" /></label>
              <button onClick={() => { const hostname = siteHost.trim().toLowerCase(); if (hostname) void update({ ...settings, siteRules: [...settings.siteRules.filter((r) => r.hostname !== hostname), { hostname, enabled: true, includeSubdomains: false, profileId: null, disabledOperations: [], typography: {}, appearance: {}, focus: {}, motion: {} }] }); }}>Add site</button>
              {settings.siteRules.map((r) => <div className="profile-row" key={r.hostname}><strong>{r.hostname}</strong><label><input type="checkbox" checked={r.enabled} onChange={(e) => void update({ ...settings, siteRules: settings.siteRules.map((x) => x.hostname === r.hostname ? { ...x, enabled: e.target.checked } : x) })} /> Enabled</label><label><input type="checkbox" checked={r.includeSubdomains} onChange={(e) => void update({ ...settings, siteRules: settings.siteRules.map((x) => x.hostname === r.hostname ? { ...x, includeSubdomains: e.target.checked } : x) })} /> Include subdomains</label><select aria-label={`Profile for ${r.hostname}`} value={r.profileId ?? ""} onChange={(e) => void update({ ...settings, siteRules: settings.siteRules.map((x) => x.hostname === r.hostname ? { ...x, profileId: e.target.value || null } : x) })}><option value="">Global profile</option>{settings.profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select><label>Font size override <input type="number" min="10" max="48" placeholder="inherit" value={r.typography.fontSize ?? ""} onChange={(e) => { const value = e.target.value ? Number(e.target.value) : undefined; void update({ ...settings, siteRules: settings.siteRules.map((x) => { if (x.hostname !== r.hostname) return x; const { fontSize: _fontSize, ...rest } = x.typography; return { ...x, typography: value === undefined ? rest : { ...rest, fontSize: value } }; }) }); }} /></label><fieldset className="op-toggles"><legend>Disable operations</legend>{["fontFamily", "fontSize", "lineHeight", "letterSpacing", "wordSpacing", "paragraphSpacing", "maxContentWidth"].map((op) => <label key={op}><input type="checkbox" checked={r.disabledOperations.includes(op)} onChange={(e) => void update({ ...settings, siteRules: settings.siteRules.map((x) => x.hostname === r.hostname ? { ...x, disabledOperations: e.target.checked ? [...x.disabledOperations, op] : x.disabledOperations.filter((id) => id !== op) } : x) })} /> {op}</label>)}</fieldset><button onClick={() => void update({ ...settings, siteRules: settings.siteRules.filter((x) => x.hostname !== r.hostname) })}>Remove</button></div>)}
            </section>
          ) : activeTab === "import-export" ? (
            <section className="tab-panel"><h2 className="tab-heading">Import / Export</h2><button onClick={() => { const blob = new Blob([JSON.stringify(settings, null, 2)], { type: "application/json" }); const url = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = url; a.download = "adaptive-web-layer-settings.json"; a.click(); URL.revokeObjectURL(url); }}>Export settings</button><label>Import mode <select value={importMode} onChange={(e) => setImportMode(e.target.value as "merge" | "replace")}><option value="replace">Replace all settings</option><option value="merge">Merge profiles and sites</option></select></label><input type="file" accept="application/json,.json" onChange={(e) => { const file = e.target.files?.[0]; if (!file) return; if (file.size > 1_000_000) { setMessage("File is too large (1 MB maximum)"); return; } void file.text().then((text) => { let raw: unknown; try { raw = JSON.parse(text); } catch { setMessage("Invalid JSON file"); return; } const parsed = SettingsSchema.safeParse(raw); if (!parsed.success) { setMessage("Settings file failed validation"); return; } const incoming = parsed.data; if (importMode === "merge") { void update({ ...settings, ...incoming, profiles: [...settings.profiles, ...incoming.profiles.filter((p) => !settings.profiles.some((x) => x.id === p.id))], siteRules: [...settings.siteRules, ...incoming.siteRules.filter((r) => !settings.siteRules.some((x) => x.hostname === r.hostname))] }); } else void update(incoming); }); }} /><button onClick={() => void update(defaultSettings())}>Reset everything</button></section>
          ) : <TabContent tabId={activeTab} />}
          {message && <p role="status">{message}</p>}
        </main>
      </div>
    </div>
  );
}

function TabContent({ tabId }: { tabId: TabId }): React.ReactElement {
  const placeholders: Partial<Record<TabId, string>> = {
    profiles: "Named profiles (Study, Night, Research, Minimal), per-site overrides — coming in P02.",
    sites: "Per-site enable/disable and site-specific settings — coming in P02.",
    "import-export": "Export and import your settings as JSON — coming in P02.",
    troubleshooting: "Debug info, extension version, and reset options — coming in P10.",
  };

  if (tabId === "appearance") {
    return <AppearanceTab />;
  }

  return (
    <div className="tab-panel">
      <h2 className="tab-heading">{TABS.find((t) => t.id === tabId)?.label}</h2>
      <p className="tab-placeholder">{placeholders[tabId]}</p>
    </div>
  );
}
