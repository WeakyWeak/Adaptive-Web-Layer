import React, { useState, useEffect, useRef, useCallback } from "react";
import type { NlCommandResult, ProviderStatus } from "../../shared/messages";
import type { Plan } from "../../shared/plan";

// ─── Provider status chip ─────────────────────────────────────────────────────
function ProviderChip({ status }: { status: ProviderStatus | null }) {
  if (!status) {
    return <span className="provider-chip chip-unknown">AI: checking…</span>;
  }
  if (status.demoMode) {
    return <span className="provider-chip chip-demo" title="No AI server — using demo responses">AI: Demo</span>;
  }
  if (status.ok) {
    const model = status.modelId ? status.modelId.split("/").pop() : "ready";
    return (
      <span className="provider-chip chip-ok" title={`${status.modelId ?? ""} — ${status.latencyMs ?? "?"}ms`}>
        AI: {model} ✓
      </span>
    );
  }
  return (
    <span className="provider-chip chip-error" title={status.error}>
      AI: offline ✗
    </span>
  );
}

// ─── AI Command Panel ─────────────────────────────────────────────────────────
export default function AICommandPanel(): React.ReactElement {
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [providerStatus, setProviderStatus] = useState<ProviderStatus | null>(null);
  const [result, setResult] = useState<NlCommandResult | null>(null);
  const [previewActive, setPreviewActive] = useState(false);
  const [appliedPlan, setAppliedPlan] = useState<Plan | null>(null);
  const [savingConsent, setSavingConsent] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Check provider status on mount
  useEffect(() => {
    chrome.runtime.sendMessage({ type: "GET_PROVIDER_STATUS" }, (response) => {
      if (chrome.runtime.lastError) return;
      if (response?.type === "PROVIDER_STATUS") {
        setProviderStatus(response as ProviderStatus);
      }
    });
  }, []);

  const getActiveTabId = (): Promise<number | null> =>
    new Promise((resolve) => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        resolve(tabs[0]?.id ?? null);
      });
    });

  const sendToTab = (tabId: number, message: Record<string, unknown>): Promise<unknown> =>
    new Promise((resolve) => {
      chrome.tabs.sendMessage(tabId, message, (response) => {
        if (chrome.runtime.lastError) resolve(null);
        else resolve(response);
      });
    });

  // Cancel preview
  const cancelPreview = useCallback(async () => {
    const tabId = await getActiveTabId();
    if (tabId) await sendToTab(tabId, { type: "REVERT_NL_PLAN" });
    setPreviewActive(false);
    setAppliedPlan(null);
  }, []);

  // Undo last applied plan
  const undoPlan = useCallback(async () => {
    const tabId = await getActiveTabId();
    if (tabId) await sendToTab(tabId, { type: "REVERT_NL_PLAN" });
    setPreviewActive(false);
    setAppliedPlan(null);
    setResult(null);
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = input.trim();
    if (!trimmed || loading) return;

    setLoading(true);
    setResult(null);
    setPreviewActive(false);
    setAppliedPlan(null);

    const tabId = await getActiveTabId();
    if (!tabId) {
      setResult({
        type: "NL_COMMAND_RESULT",
        ok: false,
        error: "No active tab found.",
        errorCode: "no-tab",
      });
      setLoading(false);
      return;
    }

    // Cancel any existing preview before running new command
    await sendToTab(tabId, { type: "REVERT_NL_PLAN" });

    chrome.runtime.sendMessage(
      { type: "NL_COMMAND", request: trimmed, tabId },
      async (response) => {
        if (chrome.runtime.lastError) {
          setResult({
            type: "NL_COMMAND_RESULT",
            ok: false,
            error: chrome.runtime.lastError.message ?? "Background not responding",
            errorCode: "runtime-error",
          });
          setLoading(false);
          return;
        }

        const cmdResult = response as NlCommandResult;
        setResult(cmdResult);
        setLoading(false);

        if (cmdResult.ok && cmdResult.plan?.operations && cmdResult.plan.operations.length > 0 && !cmdResult.shortcut) {
          // Auto-preview
          await sendToTab(tabId, {
            type: "APPLY_NL_PLAN",
            operations: cmdResult.plan.operations,
            preview: true,
          });
          setPreviewActive(true);
          setAppliedPlan(cmdResult.plan);
        }
      }
    );
  };

  const handleApply = async () => {
    const tabId = await getActiveTabId();
    if (!tabId || !appliedPlan) return;
    // Re-apply as committed (not preview)
    await sendToTab(tabId, {
      type: "APPLY_NL_PLAN",
      operations: appliedPlan.operations,
      preview: false,
    });
    setPreviewActive(false);
    // Keep appliedPlan so undo works
  };

  const saveConsent = (decision: "allow-once" | "allow-site" | "deny") => {
    const hostname = result?.consentHost;
    if (!hostname || savingConsent) return;
    setSavingConsent(true);
    chrome.runtime.sendMessage({ type: "SET_CLOUD_CONSENT", hostname, decision }, (response) => {
      setSavingConsent(false);
      if (chrome.runtime.lastError || !response?.ok) {
        setResult({ type: "NL_COMMAND_RESULT", ok: false, error: "Could not save your cloud consent choice.", errorCode: "consent-save" });
        return;
      }
      if (decision === "deny") {
        setResult({ type: "NL_COMMAND_RESULT", ok: false, error: "Cloud use was denied for this site.", errorCode: "consent-denied" });
        return;
      }
      setResult(null);
      inputRef.current?.form?.requestSubmit();
    });
  };

  return (
    <div className="ai-panel">
      <div className="ai-panel-header">
        <ProviderChip status={providerStatus} />
        {providerStatus?.demoMode && (
          <div className="demo-banner">⚠ Demo mode — no AI server connected</div>
        )}
      </div>

      <form className="ai-input-row" onSubmit={(e) => void handleSubmit(e)}>
        <input
          id="ai-nl-input"
          ref={inputRef}
          type="text"
          className="ai-input"
          placeholder='e.g. "Make text larger, keep code colors"'
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={loading}
          aria-label="Natural language command"
        />
        <button
          id="ai-nl-submit"
          type="submit"
          className="btn-primary"
          disabled={loading || !input.trim()}
          aria-busy={loading}
        >
          {loading ? "…" : "Go"}
        </button>
      </form>

      {/* Loading state */}
      {loading && (
        <div className="ai-loading" aria-live="polite">
          <span className="loading-dot" />
          <span className="loading-dot" />
          <span className="loading-dot" />
          <span>Thinking…</span>
        </div>
      )}

      {/* Result */}
      {result && !loading && (
        <div className="ai-result">
          {result.ok ? (
            <>
              {result.shortcut ? (
                <div className="ai-shortcut-done">
                  ✓ {result.interpretedRequest ?? "Shortcut applied"}
                </div>
              ) : (
                <>
                  <div className="ai-interpreted">
                    <strong>Interpreted:</strong> {result.interpretedRequest}
                    {result.confidence !== undefined && (
                      <span className="ai-confidence" title="Model confidence">
                        {" "}({Math.round(result.confidence * 100)}%)
                      </span>
                    )}
                  </div>

                  {result.descriptions && result.descriptions.length > 0 && (
                    <ul className="ai-ops-list">
                      {result.descriptions.map((desc, i) => (
                        <li key={i} className="ai-op-item">{desc}</li>
                      ))}
                    </ul>
                  )}

                  {result.warnings && result.warnings.length > 0 && (
                    <div className="ai-warnings">
                      {result.warnings.map((w, i) => (
                        <div key={i} className="ai-warning">⚠ {w}</div>
                      ))}
                    </div>
                  )}

                  {previewActive && (
                    <div className="ai-preview-note">Previewing changes…</div>
                  )}

                  <div className="ai-actions">
                    {previewActive && (
                      <>
                        <button
                          id="ai-apply-btn"
                          className="btn-primary"
                          onClick={() => void handleApply()}
                        >
                          Apply
                        </button>
                        <button
                          id="ai-cancel-btn"
                          className="btn-secondary"
                          onClick={() => void cancelPreview()}
                        >
                          Cancel
                        </button>
                      </>
                    )}
                    {appliedPlan && !previewActive && (
                      <button
                        id="ai-undo-btn"
                        className="btn-secondary"
                        onClick={() => void undoPlan()}
                      >
                        Undo AI changes
                      </button>
                    )}
                  </div>
                </>
              )}
            </>
          ) : (
            <div className="ai-error-block">
              <div className="ai-error-msg">⚠ {result.error}</div>
              {result.hint && (
                <div className="ai-error-hint">{result.hint}</div>
              )}
              {result.errorCode === "consent-required" && result.consentHost && (
                <section className="cloud-consent" aria-label="Cloud consent">
                  <strong>Before cloud AI is used on {result.consentHost}</strong>
                  <p>This request will send your command and minimal page DOM metadata to the local proxy and Gemini. It will not send a screenshot region or selected text.</p>
                  <p>Google’s free-tier Gemini service may retain or use inputs to improve models and may allow human review.</p>
                  <div className="cloud-consent-actions">
                    <button className="btn-primary" onClick={() => saveConsent("allow-once")} disabled={savingConsent}>Allow once</button>
                    <button className="btn-secondary" onClick={() => saveConsent("allow-site")} disabled={savingConsent}>Allow for this site</button>
                    <button className="btn-secondary" onClick={() => saveConsent("deny")} disabled={savingConsent}>Deny</button>
                  </div>
                </section>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
