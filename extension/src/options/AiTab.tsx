import React, { useState } from "react";
import type { AiSettings, Settings } from "../shared/settings";
import type { ProviderStatus } from "../shared/messages";

const MODES: Array<{ value: AiSettings["mode"]; title: string; detail: string }> = [
  { value: "local", title: "Local only", detail: "Only your llama-server is used. Page data never leaves this computer." },
  { value: "hybrid", title: "Hybrid", detail: "Local first. If it fails, asks you before using the cloud." },
  { value: "cloud", title: "Cloud", detail: "Gemini or Claude through your local proxy, after you consent per site." },
];

function StatusChip({ status, testing }: { status: ProviderStatus | null; testing: boolean }): React.ReactElement | null {
  if (testing) return <span className="connection-chip">Testing…</span>;
  if (!status) return null;
  return <span className={`connection-chip ${status.ok ? "connection-ok" : "connection-error"}`}>
    {status.ok ? `Connected${status.modelId ? ` · ${status.modelId}` : ""}${status.latencyMs ? ` · ${status.latencyMs} ms` : ""}` : status.error ?? "Unavailable"}
  </span>;
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }): React.ReactElement {
  return <label className="ai-field"><span className="ai-field-label">{label}</span>{children}{hint && <span className="settings-note">{hint}</span>}</label>;
}

function Check({ checked, onChange, children }: { checked: boolean; onChange: (checked: boolean) => void; children: React.ReactNode }): React.ReactElement {
  return <label className="ai-check"><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} /><span>{children}</span></label>;
}

export default function AiTab({ settings, update }: { settings: Settings; update: (settings: Settings) => Promise<void> }): React.ReactElement {
  const [status, setStatus] = useState<Record<"local" | "cloud", ProviderStatus | null>>({ local: null, cloud: null });
  const [testing, setTesting] = useState<Record<"local" | "cloud", boolean>>({ local: false, cloud: false });
  const ai = settings.ai;
  const change = (patch: Partial<AiSettings>) => void update({ ...settings, ai: { ...ai, ...patch } });
  const test = (provider: "local" | "cloud") => {
    setTesting((current) => ({ ...current, [provider]: true }));
    chrome.runtime.sendMessage({ type: "TEST_PROVIDER_CONNECTION", provider }, (response) => {
      const result: ProviderStatus = chrome.runtime.lastError
        ? { type: "PROVIDER_STATUS", ok: false, error: chrome.runtime.lastError.message, demoMode: false, provider }
        : response as ProviderStatus;
      setStatus((current) => ({ ...current, [provider]: result }));
      setTesting((current) => ({ ...current, [provider]: false }));
    });
  };
  const cloudUnused = ai.mode === "local";
  const proxyPort = (() => { try { return new URL(ai.cloudProxyUrl).port || "80"; } catch { return "8787"; } })();

  return <section className="tab-panel ai-settings">
    <h2 className="tab-heading">AI</h2>

    <div className="ai-card">
      <h3>How AI is used</h3>
      <div className="ai-modes" role="radiogroup" aria-label="AI mode">
        {MODES.map((mode) => (
          <label key={mode.value} className={`ai-mode ${ai.mode === mode.value ? "ai-mode-active" : ""}`}>
            <input type="radio" name="ai-mode" value={mode.value} checked={ai.mode === mode.value} onChange={() => change({ mode: mode.value })} />
            <span className="ai-mode-title">{mode.title}</span>
            <span className="settings-note">{mode.detail}</span>
          </label>
        ))}
      </div>
      <Check checked={ai.demoMode} onChange={(demoMode) => change({ demoMode })}>
        <strong>Demo mode</strong> — no AI model; plans come from built-in rules (for offline demos)
      </Check>
    </div>

    <div className="ai-card">
      <h3>Local model <span className="settings-note">llama-server or Ollama (OpenAI-compatible)</span></h3>
      <p className="settings-note">Start it with <code>llama-server -m &lt;model.gguf&gt; -ngl 99 -c 8192 --jinja --port 8080</code></p>
      <div className="ai-grid">
        <Field label="Endpoint"><input value={ai.localEndpoint} onChange={(event) => change({ localEndpoint: event.target.value })} /></Field>
        <Field label="Model id" hint="Informational for llama-server (it serves the model it was started with)."><input value={ai.localModel} onChange={(event) => change({ localModel: event.target.value })} /></Field>
        <Field label="Context size" hint="Must match llama-server -c."><input type="number" min="512" max="131072" value={ai.localContextSize} onChange={(event) => change({ localContextSize: Number(event.target.value) })} /></Field>
        <Field label="Timeout (seconds)"><input type="number" min="5" max="300" value={Math.round(ai.localTimeoutMs / 1000)} onChange={(event) => change({ localTimeoutMs: Number(event.target.value) * 1000 })} /></Field>
        <Field label="API key" hint="Only if llama-server was started with --api-key."><input type="password" autoComplete="off" value={ai.localApiKey} onChange={(event) => change({ localApiKey: event.target.value })} /></Field>
      </div>
      <Check checked={ai.localVision} onChange={(localVision) => change({ localVision })}>This model accepts images (started with <code>--mmproj</code>)</Check>
      <div className="ai-test-row">
        <button onClick={() => test("local")} disabled={testing.local}>Test local connection</button>
        <StatusChip status={status.local} testing={testing.local} />
      </div>
    </div>

    <div className={`ai-card ${cloudUnused ? "ai-card-muted" : ""}`}>
      <h3>Cloud <span className="settings-note">through your local proxy</span></h3>
      {cloudUnused && <p className="settings-note">Not used in Local only mode. You can still configure and test it.</p>}
      <p className="settings-note">
        The proxy holds your API keys. Run it in a terminal from the project folder with <code>npm run proxy</code> (it listens on port {proxyPort}),
        and put <code>PROXY_TOKEN</code> plus <code>GEMINI_API_KEY</code> and/or <code>ANTHROPIC_API_KEY</code> in <code>server/.env</code>.
      </p>
      <div className="ai-grid">
        <Field label="Provider">
          <select value={ai.cloudBackend} onChange={(event) => change({ cloudBackend: event.target.value as AiSettings["cloudBackend"] })}>
            <option value="gemini">Google Gemini</option>
            <option value="anthropic">Anthropic Claude</option>
          </select>
        </Field>
        {ai.cloudBackend === "gemini"
          ? <Field label="Gemini model"><input value={ai.cloudModel} onChange={(event) => change({ cloudModel: event.target.value })} /></Field>
          : <Field label="Claude model"><input value={ai.anthropicModel} onChange={(event) => change({ anthropicModel: event.target.value })} /></Field>}
        <Field label="Proxy URL"><input value={ai.cloudProxyUrl} onChange={(event) => change({ cloudProxyUrl: event.target.value })} /></Field>
        <Field label="Proxy token" hint="Same value as PROXY_TOKEN in server/.env. It unlocks only your local proxy."><input type="password" autoComplete="off" value={ai.cloudProxyToken} onChange={(event) => change({ cloudProxyToken: event.target.value })} /></Field>
      </div>
      <div className="ai-test-row">
        <button onClick={() => test("cloud")} disabled={testing.cloud}>Test cloud proxy</button>
        <StatusChip status={status.cloud} testing={testing.cloud} />
      </div>
    </div>
  </section>;
}
