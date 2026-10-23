import { useEffect, useState } from "react";
import type { z } from "zod";
import { AiJobSchema, jobKey, type AiJob } from "../shared/aiJob";
import type { ProviderStatus } from "../shared/messages";
import { understandKey, UnderstandStateSchema, type UnderstandState } from "../shared/comprehension";
import { inspectKey, InspectStateSchema, type InspectState } from "../shared/inspector";

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

/** A per-tab record in chrome.storage.session, kept live as the background rewrites it. */
function useSessionRecord<T>(tabId: number | null, keyOf: (tabId: number) => string, schema: z.ZodType<T, z.ZodTypeDef, unknown>): T | null {
  const [record, setRecord] = useState<T | null>(null);
  useEffect(() => {
    if (tabId === null) { setRecord(null); return; }
    let live = true;
    const key = keyOf(tabId);
    const read = (value: unknown) => { const parsed = schema.safeParse(value); return parsed.success ? parsed.data : null; };
    void chrome.storage.session.get(key).then((stored) => { if (live) setRecord(read(stored[key])); }).catch(() => undefined);
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === "session" && key in changes) setRecord(read(changes[key].newValue));
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => { live = false; chrome.storage.onChanged.removeListener(onChanged); };
  }, [tabId, keyOf, schema]);
  return record;
}

/** The persisted AI job for a tab; updates live as the background writes it. */
export function useAiJob(tabId: number | null): AiJob | null {
  return useSessionRecord(tabId, jobKey, AiJobSchema);
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

/** The tab's "Understand this page" state (TL;DR, glossary, last selection); updates live. */
export function useUnderstand(tabId: number | null): UnderstandState | null {
  return useSessionRecord(tabId, understandKey, UnderstandStateSchema);
}

/** The tab's inspector state (findings, score, AI interpretation); updates live. */
export function useInspect(tabId: number | null): InspectState | null {
  return useSessionRecord(tabId, inspectKey, InspectStateSchema);
}
