import React, { useState } from "react";
import type { AiSettings, Settings } from "../shared/settings";
import type { ProviderStatus } from "../shared/messages";

function StatusChip({ status }: { status: ProviderStatus | null }): React.ReactElement | null {
  if (!status) return null;
  return <span className={`connection-chip ${status.ok ? "connection-ok" : "connection-error"}`}>{status.ok ? `Connected${status.modelId ? ` · ${status.modelId}` : ""}${status.latencyMs ? ` · ${status.latencyMs}ms` : ""}` : status.error ?? "Unavailable"}</span>;
}

export default function AiTab({ settings, update }: { settings: Settings; update: (settings: Settings) => Promise<void> }): React.ReactElement {
  const [localStatus, setLocalStatus] = useState<ProviderStatus | null>(null);
  const [cloudStatus, setCloudStatus] = useState<ProviderStatus | null>(null);
  const ai = settings.ai;
  const change = (patch: Partial<AiSettings>) => void update({ ...settings, ai: { ...ai, ...patch } });
  const test = (provider: "local" | "cloud") => {
    const set = provider === "local" ? setLocalStatus : setCloudStatus;
    set(null);
    chrome.runtime.sendMessage({ type: "TEST_PROVIDER_CONNECTION", provider }, (response) => {
      if (chrome.runtime.lastError) return set({ type: "PROVIDER_STATUS", ok: false, error: chrome.runtime.lastError.message, demoMode: false, provider });
      set(response as ProviderStatus);
    });
  };

  return <section className="tab-panel ai-settings"><h2 className="tab-heading">AI</h2>
    <label>Mode <select value={ai.mode} onChange={(event) => change({ mode: event.target.value as AiSettings["mode"] })}>
      <option value="local">Local only</option>
      <option value="hybrid">Hybrid (local first, cloud with consent)</option>
      <option value="cloud">Cloud</option>
    </select></label>
    <p className="settings-note">Local only is a hard privacy gate: page data never goes to the cloud proxy. Hybrid tries local AI first and asks before using the cloud.</p>
    <label><input type="checkbox" checked={ai.demoMode} onChange={(event) => change({ demoMode: event.target.checked })} /> Demo mode (no AI; plans come from built-in rules)</label>

    <fieldset><legend>Local model (llama-server or Ollama /v1)</legend>
      <label>Endpoint <input value={ai.localEndpoint} onChange={(event) => change({ localEndpoint: event.target.value })} /></label>
      <label>Model id <input value={ai.localModel} onChange={(event) => change({ localModel: event.target.value })} /></label>
      <label>Context size <input type="number" min="512" max="131072" value={ai.localContextSize} onChange={(event) => change({ localContextSize: Number(event.target.value) })} /></label>
      <label>Timeout (seconds) <input type="number" min="5" max="300" value={Math.round(ai.localTimeoutMs / 1000)} onChange={(event) => change({ localTimeoutMs: Number(event.target.value) * 1000 })} /></label>
      <label>API key (only if llama-server uses --api-key) <input type="password" autoComplete="off" value={ai.localApiKey} onChange={(event) => change({ localApiKey: event.target.value })} /></label>
      <label><input type="checkbox" checked={ai.localVision} onChange={(event) => change({ localVision: event.target.checked })} /> This model accepts images (started with --mmproj)</label>
      <button onClick={() => test("local")}>Test local connection</button><StatusChip status={localStatus} />
    </fieldset>

    <fieldset><legend>Cloud (through your local proxy)</legend>
      <label>Provider <select value={ai.cloudBackend} onChange={(event) => change({ cloudBackend: event.target.value as AiSettings["cloudBackend"] })}>
        <option value="gemini">Google Gemini</option>
        <option value="anthropic">Anthropic Claude</option>
      </select></label>
      {ai.cloudBackend === "gemini"
        ? <label>Gemini model <input value={ai.cloudModel} onChange={(event) => change({ cloudModel: event.target.value })} /></label>
        : <label>Claude model <input value={ai.anthropicModel} onChange={(event) => change({ anthropicModel: event.target.value })} /></label>}
      <label>Proxy URL <input value={ai.cloudProxyUrl} onChange={(event) => change({ cloudProxyUrl: event.target.value })} /></label>
      <label>Proxy token <input type="password" autoComplete="off" value={ai.cloudProxyToken} onChange={(event) => change({ cloudProxyToken: event.target.value })} /></label>
      <p className="settings-note">The token unlocks only your localhost proxy. Provider keys (<code>GEMINI_API_KEY</code>, <code>ANTHROPIC_API_KEY</code>) stay in <code>server/.env</code>.</p>
      <button onClick={() => test("cloud")}>Test cloud proxy</button><StatusChip status={cloudStatus} />
    </fieldset>
  </section>;
}
