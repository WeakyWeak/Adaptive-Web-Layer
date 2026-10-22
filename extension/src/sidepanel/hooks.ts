import { useEffect, useState } from "react";
import { AiJobSchema, jobKey, readJob, type AiJob } from "../shared/aiJob";
import type { ProviderStatus } from "../shared/messages";

export interface ActiveTab { id: number; url: string; hostname: string }

/** The tab the side panel acts on: the active tab of this window, kept current. */
export function useActiveTab(): ActiveTab | null {
  const [tab, setTab] = useState<ActiveTab | null>(null);
  useEffect(() => {
    const refresh = () => chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const current = tabs[0];
      if (!current?.id) { setTab(null); return; }
      let hostname = "";
      try { hostname = new URL(current.url ?? "").hostname; } catch { /* restricted page */ }
      setTab({ id: current.id, url: current.url ?? "", hostname });
    });
    refresh();
    const onActivated = () => refresh();
    const onUpdated = (_id: number, change: chrome.tabs.TabChangeInfo) => { if (change.url || change.status === "complete") refresh(); };
    chrome.tabs.onActivated.addListener(onActivated);
    chrome.tabs.onUpdated.addListener(onUpdated);
    return () => {
      chrome.tabs.onActivated.removeListener(onActivated);
      chrome.tabs.onUpdated.removeListener(onUpdated);
    };
  }, []);
  return tab;
}

/** The persisted AI job for a tab; updates live as the background writes it. */
export function useAiJob(tabId: number | null): AiJob | null {
  const [job, setJob] = useState<AiJob | null>(null);
  useEffect(() => {
    if (tabId === null) { setJob(null); return; }
    let live = true;
    void readJob(tabId).then((stored) => { if (live) setJob(stored); });
    const key = jobKey(tabId);
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area !== "session" || !(key in changes)) return;
      const parsed = AiJobSchema.safeParse(changes[key].newValue);
      setJob(parsed.success ? parsed.data : null);
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => { live = false; chrome.storage.onChanged.removeListener(onChanged); };
  }, [tabId]);
  return job;
}

export function useProviderStatus(refreshKey: unknown): ProviderStatus | null {
  const [status, setStatus] = useState<ProviderStatus | null>(null);
  useEffect(() => {
    setStatus(null);
    chrome.runtime.sendMessage({ type: "GET_PROVIDER_STATUS" }, (response) => {
      if (chrome.runtime.lastError) return;
      if (response?.type === "PROVIDER_STATUS") setStatus(response as ProviderStatus);
    });
  }, [refreshKey]);
  return status;
}

/** Send a command to the background; resolves to an error message or null. */
export function command(message: Record<string, unknown>): Promise<string | null> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response?: { ok?: boolean; error?: string }) => {
      if (chrome.runtime.lastError) resolve(chrome.runtime.lastError.message ?? "The extension is not responding.");
      else resolve(response?.ok === false ? response.error ?? "Request failed." : null);
    });
  });
}
