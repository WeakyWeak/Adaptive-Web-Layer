import React, { useState } from "react";
import type { AiSettings, Settings } from "../shared/settings";
import type { ProviderStatus } from "../shared/messages";

function StatusChip({ status }: { status: ProviderStatus | null }): React.ReactElement | null {
  if (!status) return null;
  return <span className={`connection-chip ${status.ok ? "connection-ok" : "connection-error"}`}>{status.ok ? `Connected${status.latencyMs ? ` · ${status.latencyMs}ms` : ""}` : status.error ?? "Unavailable"}</span>;
}

export default function AiTab({ settings, update }: { settings: Settings; update: (settings: Settings) => Promise<void> }): React.ReactElement {
  const [localStatus, setLocalStatus] = useState<ProviderStatus | null>(null);
  const [cloudStatus, setCloudStatus] = useState<ProviderStatus | null>(null);
  const change = (patch: Partial<AiSettings>) => void update({ ...settings, ai: { ...settings.ai, ...patch } });
  const test = (provider: "local" | "cloud") => {
    chrome.runtime.sendMessage({ type: "TEST_PROVIDER_CONNECTION", provider }, (response) => {
      if (chrome.runtime.lastError) return (provider === "local" ? setLocalStatus : setCloudStatus)({ type: "PROVIDER_STATUS", ok: false, error: chrome.runtime.lastError.message, demoMode: false, provider });
      (provider === "local" ? setLocalStatus : setCloudStatus)(response as ProviderStatus);
    });
  };

  return <section className="tab-panel ai-settings"><h2 className="tab-heading">AI</h2>
    <label>Mode <select value={settings.ai.mode} onChange={(event) => change({ mode: event.target.value as AiSettings["mode"] })}><option value="local">Local only</option><option value="cloud">Cloud</option><option value="hybrid">Hybrid</option></select></label>
    <p className="settings-note">Local mode is a hard privacy gate: no page data is sent to the cloud proxy.</p>
    <fieldset><legend>Local model</legend>
      <label>Endpoint <input value={settings.ai.localEndpoint} onChange={(event) => change({ localEndpoint: event.target.value })} /></label>
      <label>Model <input value={settings.ai.localModel} onChange={(event) => change({ localModel: event.target.value })} /></label>
      <label>Context size <input type="number" min="512" max="131072" value={settings.ai.localContextSize} onChange={(event) => change({ localContextSize: Number(event.target.value) })} /></label>
      <button onClick={() => test("local")}>Test local connection</button><StatusChip status={localStatus} />
    </fieldset>
    <fieldset><legend>Cloud proxy</legend>
      <label>Gemini model <input value={settings.ai.cloudModel} onChange={(event) => change({ cloudModel: event.target.value })} /></label>
      <label>Proxy URL <input value={settings.ai.cloudProxyUrl} onChange={(event) => change({ cloudProxyUrl: event.target.value })} /></label>
      <label>Proxy token <input type="password" autoComplete="off" value={settings.ai.cloudProxyToken} onChange={(event) => change({ cloudProxyToken: event.target.value })} /></label>
      <p className="settings-note">The token authorizes only your localhost proxy; Gemini and Sarvam keys stay in <code>server/.env</code>.</p>
      <button onClick={() => test("cloud")}>Test cloud proxy</button><StatusChip status={cloudStatus} />
    </fieldset>
  </section>;
}
