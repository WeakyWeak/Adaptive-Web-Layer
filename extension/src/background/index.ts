// Background service worker (MV3)
// Stateless: MV3 service workers are terminated when idle.
// All state must be persisted in chrome.storage, never held in memory.

import { parseMessage, type AnyMessage } from "../shared/messages";
import { loadSettings, onSettingsChange, saveSettings } from "../shared/storage";
import { isSiteEnabled, normalizeHostname, resolveAppearance, resolveTypography, type Settings } from "../shared/settings";
import { ProviderRouter } from "../shared/providerRouter";
import { readJob } from "../shared/aiJob";
import { applyJob, discardJob, runAiJob, saveProfile, setElementEnabled, undoJob, useFallback } from "./aiJobs";
import { clearUnderstand, failOrphanedUnderstand, hideOnPage, retryUnderstand, runPageKind, runSelection } from "./comprehension";
import { applyInspectFixes, cancelInspect, clearInspect, explainInspect, failOrphanedInspect, runInspect, undoInspectFixes } from "./inspect";
import { cancelJob, clearJob, failOrphanedJobs } from "./jobs";

console.log("[AWL background] service worker started");
void failOrphanedJobs();
void failOrphanedUnderstand();
void failOrphanedInspect();

async function refreshBadge(tabId: number, url?: string): Promise<void> {
  if (!url) return;
  try {
    const hostname = new URL(url).hostname;
    const settings = await loadSettings();
    const defaults: Record<string, unknown> = { fontFamily: "", fontSize: 16, lineHeight: 1.5, letterSpacing: 0, wordSpacing: 0, paragraphSpacing: 0, maxContentWidth: 800 };
    const appearance = resolveAppearance(settings, hostname);
    const appearanceActive = appearance.theme !== "light" || appearance.contrast !== 1 || appearance.brightness !== 1 || appearance.saturation !== 1;
    const active = isSiteEnabled(settings, hostname) && (appearanceActive || Object.entries(resolveTypography(settings, hostname)).some(([key, value]) => value !== defaults[key]));
    await chrome.action.setBadgeText({ tabId, text: active ? "ON" : "" });
    await chrome.action.setBadgeBackgroundColor({ tabId, color: "#4f46e5" });
  } catch { /* Tabs can close between query and badge update. */ }
}

void loadSettings().then(() => chrome.tabs.query({}, (tabs) => tabs.forEach((tab) => { if (tab.id) void refreshBadge(tab.id, tab.url); })));
onSettingsChange(() => chrome.tabs.query({}, (tabs) => tabs.forEach((tab) => { if (tab.id) void refreshBadge(tab.id, tab.url); })));
chrome.tabs.onActivated.addListener(({ tabId }) => chrome.tabs.get(tabId, (tab) => { if (!chrome.runtime.lastError) void refreshBadge(tabId, tab.url); }));
chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (change.status === "complete" || change.url) void refreshBadge(tabId, tab.url);
  // A preview lives in the page; navigating away drops it, so drop the job too.
  if (change.status === "loading") {
    void readJob(tabId).then((job) => {
      if (job && (job.status === "preview" || job.status === "running")) {
        cancelJob(tabId);
        void clearJob(tabId);
      }
    });
    // Comprehension results belong to the page that was loaded.
    cancelJob(tabId, "understand");
    void clearUnderstand(tabId);
    // Inspector findings point at elements of the page that was loaded.
    cancelJob(tabId, "inspect");
    void clearInspect(tabId);
  }
});
chrome.tabs.onRemoved.addListener((tabId) => { cancelJob(tabId); void clearJob(tabId); cancelJob(tabId, "understand"); void clearUnderstand(tabId); cancelJob(tabId, "inspect"); void clearInspect(tabId); });

// ── Provider status ───────────────────────────────────────────────────────────
async function providerStatus(settings: Settings, target: "local" | "cloud") {
  if (settings.ai.demoMode) return { type: "PROVIDER_STATUS" as const, ok: true, modelId: "demo", demoMode: true, provider: target };
  // An explicit test (Options → Test cloud proxy) may contact the proxy even in
  // local mode: it is a health check and carries no page data.
  const router = new ProviderRouter({ settings: { ...settings.ai, mode: target === "cloud" ? "cloud" : settings.ai.mode }, consent: "pending" });
  const status = await router.testConnection(target);
  return { type: "PROVIDER_STATUS" as const, ...status, demoMode: false, provider: target };
}

type Reply = (response: unknown) => void;

function ack(reply: Reply, error: string | null): void {
  reply({ type: "ACK", ok: error === null, error: error ?? undefined });
}

/** Handles one parsed message. Returns true when `reply` will be called asynchronously. */
function handle(msg: AnyMessage, reply: Reply, sender: chrome.runtime.MessageSender): boolean {
  switch (msg.type) {
    case "PING":
      reply({ type: "PONG", version: chrome.runtime.getManifest().version });
      return false;

    case "GET_PAGE_INFO":
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tabId = tabs[0]?.id;
        if (!tabId) { reply(null); return; }
        chrome.tabs.sendMessage(tabId, { type: "GET_PAGE_INFO" }, (response) => reply(chrome.runtime.lastError ? null : response));
      });
      return true;

    case "GET_PROVIDER_STATUS":
      void loadSettings()
        .then((settings) => providerStatus(settings, settings.ai.mode === "cloud" ? "cloud" : "local"))
        .then(reply)
        .catch((error) => reply({ type: "PROVIDER_STATUS", ok: false, error: String(error), demoMode: false }));
      return true;

    case "TEST_PROVIDER_CONNECTION":
      void loadSettings()
        .then((settings) => providerStatus(settings, msg.provider))
        .then(reply)
        .catch((error) => reply({ type: "PROVIDER_STATUS", ok: false, error: String(error), demoMode: false, provider: msg.provider }));
      return true;

    case "SET_CLOUD_CONSENT":
      void (async () => {
        const settings = await loadSettings();
        const hostname = normalizeHostname(msg.hostname);
        const privacy = { ...settings.privacy, cloudConsentTimestamp: Date.now() };
        if (msg.decision === "allow-once") {
          privacy.cloudAllowOnceFor = hostname;
        } else {
          privacy.cloudAllowOnceFor = undefined;
          privacy.cloudSiteConsents = { ...privacy.cloudSiteConsents, [hostname]: msg.decision === "allow-site" ? "allow" : "deny" };
        }
        ack(reply, await saveSettings({ ...settings, privacy }) ? null : "Could not save cloud consent.");
      })();
      return true;

    case "AI_RUN":
      // The result is delivered through the job record, not this reply.
      void runAiJob(msg.tabId, msg.request);
      ack(reply, null);
      return false;

    case "AI_CANCEL":
      ack(reply, cancelJob(msg.tabId) ? null : "Nothing is running.");
      return false;

    case "AI_APPLY":
      void applyJob(msg.tabId).then((error) => ack(reply, error));
      return true;

    case "AI_UNDO":
      void undoJob(msg.tabId).then((error) => ack(reply, error));
      return true;

    case "AI_DISCARD":
      void discardJob(msg.tabId).then(() => ack(reply, null));
      return true;

    case "AI_USE_FALLBACK":
      void useFallback(msg.tabId).then((error) => ack(reply, error));
      return true;

    case "AI_SET_ELEMENT":
      void setElementEnabled(msg.tabId, msg.id, msg.enabled).then((error) => ack(reply, error));
      return true;

    // ── P08: comprehension (results arrive through the per-tab state) ──
    case "UNDERSTAND_RUN":
      void runPageKind(msg.tabId, msg.kind, msg.refresh);
      ack(reply, null);
      return false;

    case "UNDERSTAND_SELECTION":
      // Only the page's own content script sends this; the tab is the sender's.
      if (sender.tab?.id === undefined) { ack(reply, "Selection actions come from a page."); return false; }
      void runSelection(sender.tab.id, msg);
      ack(reply, null);
      return false;

    case "UNDERSTAND_RETRY":
      void retryUnderstand(msg.tabId, msg.local).then((error) => ack(reply, error));
      return true;

    case "UNDERSTAND_HIDE":
      void hideOnPage(msg.tabId, msg.what).then(() => ack(reply, null));
      return true;

    case "UNDERSTAND_CANCEL":
      ack(reply, cancelJob(msg.tabId, "understand") ? null : "Nothing is running.");
      return false;

    // ── P09: inspector (results arrive through the per-tab inspect state) ──
    case "INSPECT_RUN":
      void runInspect(msg.tabId).then(() => ack(reply, null));
      return true;

    case "INSPECT_EXPLAIN":
      void explainInspect(msg.tabId).then((error) => ack(reply, error));
      return true;

    case "INSPECT_APPLY":
      void applyInspectFixes(msg.tabId, msg.ids).then((error) => ack(reply, error));
      return true;

    case "INSPECT_UNDO":
      void undoInspectFixes(msg.tabId).then((error) => ack(reply, error));
      return true;

    case "INSPECT_CANCEL":
      ack(reply, cancelInspect(msg.tabId));
      return false;

    case "AI_SAVE_PROFILE":
      void saveProfile(msg.tabId, msg.name).then((error) => ack(reply, error));
      return true;

    default:
      return false;
  }
}

chrome.runtime.onMessage.addListener((raw, sender, sendResponse) => {
  const msg = parseMessage(raw);
  return msg ? handle(msg, sendResponse, sender) : false;
});

// The toolbar button keeps the quick-settings popup; the AI panel opens from it.
void chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => undefined);

chrome.runtime.onInstalled.addListener((details) => {
  console.log("[AWL background] installed/updated:", details.reason);
});
