import React, { useState } from "react";
import "./options.css";
import AppearanceTab from "./AppearanceTab";

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
          <TabContent tabId={activeTab} />
        </main>
      </div>
    </div>
  );
}

function TabContent({ tabId }: { tabId: TabId }): React.ReactElement {
  const placeholders: Partial<Record<TabId, string>> = {
    profiles: "Named profiles (Study, Night, Research, Minimal), per-site overrides — coming in P02.",
    sites: "Per-site enable/disable and site-specific settings — coming in P02.",
    ai: "Local AI endpoint (llama-server), cloud AI (Gemini), and Sarvam translation settings — coming in P05/P06.",
    privacy: "Cloud consent, data retention, and privacy controls — coming in P06.",
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
