// Background service worker (MV3)
// Stateless: MV3 service workers are terminated when idle.
// All state must be persisted in chrome.storage, never held in memory.

import { parseMessage } from "../shared/messages";
import { loadSettings, onSettingsChange, saveSettings } from "../shared/storage";
import { cloudConsentFor, isSiteEnabled, normalizeHostname, resolveAppearance, resolveTypography, type Settings } from "../shared/settings";
import { LocalOpenAICompatProvider, MockProvider } from "../shared/llmProvider";
import { ProviderRouter } from "../shared/providerRouter";
import { runPlanner, describeOperations } from "./planner";
import { detectShortcut, ProviderError, formatProviderError } from "../shared/plan";
import { registerPlanningOperations } from "./operationRegistry";

console.log("[AWL background] service worker started");
// MV3 workers do not share the content script's in-memory operation registry.
// Register before any AI command can build or validate a plan.
registerPlanningOperations();

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
chrome.tabs.onUpdated.addListener((tabId, change, tab) => { if (change.status === "complete" || change.url) void refreshBadge(tabId, tab.url); });

// ── Build a provider from settings ────────────────────────────────────────────
async function buildProvider(settings: Settings, hostname = ""): Promise<LocalOpenAICompatProvider | MockProvider | ProviderRouter> {
  const ai = settings.ai;
  if (ai.demoMode) return new MockProvider();
  if (ai.mode === "local") {
    return new LocalOpenAICompatProvider({
      endpoint: ai.localEndpoint,
      modelId: ai.localModel,
      contextSize: ai.localContextSize,
      timeoutMs: ai.localTimeoutMs,
      apiKey: ai.localApiKey || undefined,
    });
  }
  return new ProviderRouter({
    settings: ai,
    cloudAllowed: hostname ? cloudConsentFor(settings.privacy, hostname) === "allow" : false,
  });
}

// Track in-flight NL command abort controllers (keyed by tabId)
const _nlAborts = new Map<number, AbortController>();

// ── Message handler ───────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((raw, _sender, sendResponse) => {
  const msg = parseMessage(raw);
  if (!msg) return false;

  if (msg.type === "PING") {
    sendResponse({ type: "PONG", version: chrome.runtime.getManifest().version });
    return false; // synchronous response
  }

  // Forward GET_PAGE_INFO to the active tab's content script
  if (msg.type === "GET_PAGE_INFO") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (!tab?.id) {
        sendResponse(null);
        return;
      }
      chrome.tabs.sendMessage(tab.id, { type: "GET_PAGE_INFO" }, (response) => {
        if (chrome.runtime.lastError) {
          console.warn("[AWL background] content script error:", chrome.runtime.lastError.message);
          sendResponse(null);
        } else {
          sendResponse(response);
        }
      });
    });
    return true; // async response
  }

  // ── P05: Provider status check ──────────────────────────────────────────────
  if (msg.type === "GET_PROVIDER_STATUS") {
    void (async () => {
      try {
        const settings = await loadSettings();
        const provider = await buildProvider(settings);
        const status = await provider.testConnection();
        sendResponse({
          type: "PROVIDER_STATUS",
          ok: status.ok,
          latencyMs: status.latencyMs,
          modelId: status.modelId,
          error: status.error,
          demoMode: settings.ai.demoMode,
          provider: settings.ai.mode === "cloud" ? "cloud" : "local",
        });
      } catch (err) {
        sendResponse({
          type: "PROVIDER_STATUS",
          ok: false,
          error: String(err),
          demoMode: false,
        });
      }
    })();
    return true;
  }

  if (msg.type === "TEST_PROVIDER_CONNECTION") {
    void (async () => {
      const settings = await loadSettings();
      const testSettings: Settings = { ...settings, ai: { ...settings.ai, mode: msg.provider } };
      const status = await buildProvider(testSettings);
      const result = await status.testConnection();
      sendResponse({ type: "PROVIDER_STATUS", ...result, demoMode: settings.ai.demoMode, provider: msg.provider });
    })().catch((error) => sendResponse({ type: "PROVIDER_STATUS", ok: false, error: String(error), demoMode: false, provider: msg.provider }));
    return true;
  }

  if (msg.type === "SET_CLOUD_CONSENT") {
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
      const ok = await saveSettings({ ...settings, privacy });
      sendResponse({ type: "ACK", ok, error: ok ? undefined : "Could not save cloud consent." });
    })();
    return true;
  }

  // ── P05: NL command ─────────────────────────────────────────────────────────
  if (msg.type === "NL_COMMAND") {
    const { request, tabId } = msg;

    void (async () => {
      // Cancel any previous in-flight request for this tab
      _nlAborts.get(tabId)?.abort("superseded");
      const ctrl = new AbortController();
      _nlAborts.set(tabId, ctrl);
      let hostname = "";

      try {
        // ── Deterministic shortcuts first (no AI call) ────────────────────
        const shortcut = detectShortcut(request);
        if (shortcut) {
          if (shortcut.type === "undo") {
            chrome.tabs.sendMessage(tabId, { type: "UNDO_PAGE" });
          } else if (shortcut.type === "reset") {
            chrome.tabs.sendMessage(tabId, { type: "RESET_PAGE" });
          } else if (shortcut.type === "turn-off") {
            const settings = await loadSettings();
            const tab = await chrome.tabs.get(tabId);
            const hostname = tab.url ? new URL(tab.url).hostname : "";
            if (hostname) {
              const siteRules = settings.siteRules.filter((r) => r.hostname !== hostname);
              siteRules.push({ hostname, enabled: false, includeSubdomains: false, profileId: null, disabledOperations: [], typography: {}, appearance: {}, focus: undefined, motion: undefined });
              await saveSettings({ ...settings, siteRules });
            }
          } else if (shortcut.type === "save-profile") {
            // Save current ops as a profile — basic implementation
            const settings = await loadSettings();
            const tab = await chrome.tabs.get(tabId);
            const hostname = tab.url ? new URL(tab.url).hostname : "";
            const existing = settings.profiles.find((p) => p.name.toLowerCase() === shortcut.name.toLowerCase());
            if (!existing) {
              const typography = resolveTypography(settings, hostname);
              const newProfile = { id: `custom-${Date.now()}`, name: shortcut.name, builtIn: false, typography, appearance: resolveAppearance(settings, hostname) };
              await saveSettings({ ...settings, profiles: [...settings.profiles, newProfile] });
            }
          }
          sendResponse({
            type: "NL_COMMAND_RESULT",
            ok: true,
            shortcut: true,
            interpretedRequest: shortcut.type,
            descriptions: [`Shortcut: ${shortcut.type}`],
            confidence: 1,
          });
          return;
        }

        // ── Get DOM snapshot from content script ──────────────────────────
        let snapshot: unknown;
        try {
          snapshot = await new Promise((resolve, reject) => {
            chrome.tabs.sendMessage(tabId, { type: "GET_DOM_SNAPSHOT" }, (response) => {
              if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message ?? "No content script"));
              } else {
                resolve(response?.payload ?? null);
              }
            });
          });
        } catch (err) {
          sendResponse({
            type: "NL_COMMAND_RESULT",
            ok: false,
            error: "Could not read the page. Make sure the extension is active on this page.",
            errorCode: "no-content-script",
          });
          return;
        }

        if (!snapshot) {
          sendResponse({
            type: "NL_COMMAND_RESULT",
            ok: false,
            error: "No page snapshot received.",
            errorCode: "no-snapshot",
          });
          return;
        }

        // ── Build provider + run planner ──────────────────────────────────
        const settings = await loadSettings();
        const tab = await chrome.tabs.get(tabId);
        hostname = tab.url ? new URL(tab.url).hostname : "";
        const provider = await buildProvider(settings, hostname);

        // Hard gate: in local mode, NOTHING leaves the machine.
        // Provider routing enforces this (LocalOpenAICompatProvider never calls cloud).

        const { validated, retried } = await runPlanner(
          provider,
          request,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          snapshot as any,
          ctrl.signal
        );

        _nlAborts.delete(tabId);

        // An Allow once permission is consumed immediately after its single call.
        if (settings.privacy.cloudAllowOnceFor === normalizeHostname(hostname)) {
          await saveSettings({ ...settings, privacy: { ...settings.privacy, cloudAllowOnceFor: undefined } });
        }

        const descriptions = describeOperations(validated.validOps);

        sendResponse({
          type: "NL_COMMAND_RESULT",
          ok: true,
          plan: { ...validated.plan, operations: validated.validOps },
          descriptions,
          interpretedRequest: validated.plan.interpretedRequest,
          confidence: validated.plan.confidence,
          warnings: [
            ...(retried ? ["Plan was retried due to validation errors."] : []),
            ...validated.errors,
          ],
        });
      } catch (err) {
        _nlAborts.delete(tabId);

        if (err instanceof ProviderError) {
          const { message, hint } = formatProviderError(err);
          sendResponse({
            type: "NL_COMMAND_RESULT",
            ok: false,
            error: message,
            errorCode: err.code,
            hint,
            consentHost: err.code === "consent-required" ? hostname : undefined,
          });
        } else {
          sendResponse({
            type: "NL_COMMAND_RESULT",
            ok: false,
            error: String(err),
            errorCode: "unknown",
          });
        }
      }
    })();
    return true; // async response
  }

  return false;
});

// ── Install / update lifecycle ────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener((details) => {
  console.log("[AWL background] installed/updated:", details.reason);
});

