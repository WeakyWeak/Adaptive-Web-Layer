import React, { useEffect, useState } from "react";
import type { ProviderStatus } from "../shared/messages";
import { defaultSettings, type Settings } from "../shared/settings";
import { loadSettings, onSettingsChange } from "../shared/storage";
import { useActiveTab, useProviderStatus } from "./hooks";
import { sections } from "./panels/index";
import "./sidepanel.css";

function describeMode(settings: Settings): string {
  if (settings.ai.demoMode) return "Demo mode";
  const cloud = { gemini: "Gemini", anthropic: "Claude", openai: "OpenAI-compatible" }[settings.ai.cloudBackend];
  if (settings.ai.mode === "local") return "Local only";
  if (settings.ai.mode === "cloud") return `Cloud (${cloud})`;
  return `Hybrid (local + ${cloud} review)`;
}

function StatusChip({ status }: { status: ProviderStatus | null }): React.ReactElement {
  if (!status) return <span className="chip">checking…</span>;
  if (status.demoMode) return <span className="chip demo">demo</span>;
  return status.ok
    ? <span className="chip ok" title={`${status.latencyMs ?? "?"} ms`}>{status.modelId?.split("/").pop() ?? "ready"}</span>
    : <span className="chip bad" title={status.error}>offline</span>;
}

export default function SidePanelApp(): React.ReactElement {
  const tab = useActiveTab();
  const [settings, setSettings] = useState<Settings>(defaultSettings());
  useEffect(() => {
    void loadSettings().then(setSettings);
    return onSettingsChange(setSettings);
  }, []);
  const status = useProviderStatus(`${settings.ai.mode}|${settings.ai.cloudBackend}|${settings.ai.demoMode}|${settings.ai.localEndpoint}`);

  return (
    <div className="shell">
      <header>
        <span className="logo" aria-hidden="true">⬡</span>
        <div>
          <h1>Adaptive Web Layer</h1>
          <p className="muted">{tab?.hostname || "No page"} · {describeMode(settings)} <StatusChip status={status} /></p>
        </div>
      </header>
      {settings.ai.demoMode && <div className="banner">Demo mode: no AI model is used; plans come from built-in rules.</div>}
      {status && !status.ok && !status.demoMode && <p className="muted small">{status.error}</p>}
      {sections.map(({ id, title, Component }) => (
        <section key={id} className="section">
          <h2>{title}</h2>
          <Component tab={tab} settings={settings} />
        </section>
      ))}
      <footer><button onClick={() => chrome.runtime.openOptionsPage()}>AI &amp; privacy settings</button></footer>
    </div>
  );
}
