import React, { useEffect, useState } from "react";
import type { Settings } from "../../shared/settings";
import { pruneSiteSelectors } from "../../shared/sitePatch";
import { loadSettings, saveSettings } from "../../shared/storage";
import type { ActiveTab } from "../hooks";

interface Check { total: number; stale: string[] }

/** Saved element rules for this site; offers to remove the ones that no longer match. */
export default function SavedRules({ tab, settings }: { tab: ActiveTab | null; settings: Settings }): React.ReactElement | null {
  const [check, setCheck] = useState<Check | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setCheck(null);
    if (!tab?.hostname) return;
    chrome.tabs.sendMessage(tab.id, { type: "CHECK_SAVED_SELECTORS" }, (response?: { type?: string; total?: number; stale?: string[] }) => {
      if (chrome.runtime.lastError || response?.type !== "SAVED_SELECTORS") return;
      setCheck({ total: response.total ?? 0, stale: response.stale ?? [] });
    });
  }, [tab?.id, tab?.hostname, tab?.url, settings]);

  if (!tab || !check || check.total === 0) return null;
  const cleanUp = async () => {
    const latest = await loadSettings();
    setError(await saveSettings(pruneSiteSelectors(latest, tab.hostname, check.stale)) ? null : "Could not update the saved rules.");
  };
  return (
    <div className="saved-rules">
      <p className="muted small">{check.total} saved element rule{check.total === 1 ? "" : "s"} on {tab.hostname}, applied without AI.</p>
      {check.stale.length > 0 && (
        <div className="row">
          <span className="warning">{check.stale.length} saved rule{check.stale.length === 1 ? " no longer matches" : "s no longer match"} anything on this page (they may still apply to other pages of this site).</span>
          <button onClick={() => void cleanUp()}>Remove {check.stale.length === 1 ? "it" : "them"}</button>
        </div>
      )}
      {error && <p className="error-text">{error}</p>}
    </div>
  );
}
