// ─── Talking to a tab's content script (background only) ─────────────────────

import { normalizeHostname } from "../shared/settings";

/** Send a message to the tab; resolves to the reply, or null if nothing answered. */
export function tabMessage<T>(tabId: number, message: unknown): Promise<T | null> {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, (response: T) => resolve(chrome.runtime.lastError ? null : response ?? null));
  });
}

/** Fire-and-forget message to the tab. */
export function tell(tabId: number, message: unknown): void {
  chrome.tabs.sendMessage(tabId, message, () => void chrome.runtime.lastError);
}

/** The tab's URL and hostname when it is a regular web page; null otherwise. */
export async function tabPage(tabId: number): Promise<{ url: string; hostname: string } | null> {
  try {
    const tab = await chrome.tabs.get(tabId);
    const url = new URL(tab.url ?? "");
    return url.protocol === "http:" || url.protocol === "https:" ? { url: url.href, hostname: normalizeHostname(url.hostname) } : null;
  } catch {
    return null;
  }
}
