// ─── Provider router: the single AI choke point (SPEC §3) ────────────────────
// Every AI call goes through `route()`. In local mode the cloud branch is not
// reachable at all; that is the privacy gate, and it is tested.

import type { AiSettings, CloudConsent } from "./settings";
import { CloudProvider, LocalOpenAICompatProvider, type ConnectionStatus, type LLMProvider, type StructuredRequest, type TranslateRequest } from "./llmProvider";
import { ProviderError } from "./plan";

export interface RouterOptions {
  settings: AiSettings;
  /** Cloud consent for the page's site. */
  consent: CloudConsent;
  local?: LLMProvider;
  cloud?: LLMProvider;
}

export function createLocalProvider(settings: AiSettings): LLMProvider {
  return new LocalOpenAICompatProvider({
    endpoint: settings.localEndpoint,
    modelId: settings.localModel,
    contextSize: settings.localContextSize,
    timeoutMs: settings.localTimeoutMs,
    apiKey: settings.localApiKey || undefined,
    supportsVision: settings.localVision,
  });
}

export function createCloudProvider(settings: AiSettings): LLMProvider {
  return new CloudProvider({
    proxyUrl: settings.cloudProxyUrl,
    proxyToken: settings.cloudProxyToken,
    backend: settings.cloudBackend,
    modelId: settings.cloudBackend === "anthropic" ? settings.anthropicModel : settings.cloudModel,
    timeoutMs: settings.cloudTimeoutMs,
  });
}

function isUserCancel(error: unknown, signal?: AbortSignal): boolean {
  return Boolean(signal?.aborted) || (error instanceof ProviderError && error.code === "cancelled");
}

export class ProviderRouter {
  private readonly local: LLMProvider;
  private readonly cloud: LLMProvider;
  /** Which provider produced the last successful reply. */
  usedProvider: "local" | "cloud" | null = null;

  constructor(private readonly options: RouterOptions) {
    this.local = options.local ?? createLocalProvider(options.settings);
    this.cloud = options.cloud ?? createCloudProvider(options.settings);
  }

  private requireCloudConsent(reason?: string): void {
    if (this.options.consent === "allow") return;
    if (this.options.consent === "deny") throw new ProviderError("consent-denied", "Cloud AI is denied for this site.");
    throw new ProviderError("consent-required", reason ?? "Cloud AI needs your consent before any page data is sent.");
  }

  private async callCloud<T>(call: (provider: LLMProvider) => Promise<T>, reason?: string): Promise<T> {
    this.requireCloudConsent(reason);
    const result = await call(this.cloud);
    this.usedProvider = "cloud";
    return result;
  }

  private async callLocal<T>(call: (provider: LLMProvider) => Promise<T>): Promise<T> {
    const result = await call(this.local);
    this.usedProvider = "local";
    return result;
  }

  private async route<T>(needsVision: boolean, call: (provider: LLMProvider) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const { mode } = this.options.settings;
    const localCanServe = !needsVision || this.local.supportsVision;

    if (mode === "local") {
      // Hard gate: there is no cloud branch in local mode.
      if (!localCanServe) throw new ProviderError("unsupported", "Local mode cannot analyse screenshots with this model.");
      return this.callLocal(call);
    }
    if (mode === "cloud" || !localCanServe) return this.callCloud(call);

    // Hybrid: local first; cloud only after a real local failure and consent.
    try {
      return await this.callLocal(call);
    } catch (localError) {
      if (isUserCancel(localError, signal)) throw localError;
      if (this.options.consent === "deny") throw localError;
      const message = localError instanceof Error ? localError.message : String(localError);
      return this.callCloud(call, `Local AI failed (${message}). Cloud AI can try instead if you allow it.`);
    }
  }

  generateStructured(request: StructuredRequest): Promise<unknown> {
    return this.route(Boolean(request.images?.length), (provider) => provider.generateStructured(request), request.signal);
  }

  /**
   * Machine translation runs only in the cloud (Sarvam via the proxy), so it is
   * never reachable in local mode, and needs consent in hybrid and cloud mode.
   * There is no silent local fallback: callers offer the local model explicitly.
   */
  async translate(request: TranslateRequest): Promise<string> {
    if (this.options.settings.mode === "local") {
      throw new ProviderError("unsupported", "Translation uses Sarvam, a cloud service, and local mode never sends text off this computer.", "Use the local model instead (lower quality), or switch AI mode to hybrid or cloud in Settings.");
    }
    const cloud = this.cloud;
    if (!cloud.translate) throw new ProviderError("unsupported", "The cloud provider cannot translate.");
    return this.callCloud(() => cloud.translate!(request), "Translation sends the selected text to Sarvam (cloud) through your local proxy.");
  }

  /** Connection checks never send page data, so they need no consent. */
  testConnection(target: "local" | "cloud"): Promise<ConnectionStatus> {
    if (target === "cloud" && this.options.settings.mode === "local") {
      return Promise.resolve({ ok: false, error: "Local mode: the cloud proxy is never contacted." });
    }
    return (target === "cloud" ? this.cloud : this.local).testConnection();
  }
}
