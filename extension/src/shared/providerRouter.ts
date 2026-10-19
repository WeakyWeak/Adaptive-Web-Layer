import type { AiSettings } from "./settings";
import { CloudProvider, type AnalyzeImageOpts, type ConnectionStatus, type GenerateStructuredOpts, type GenerateTextOpts, type LLMProvider, LocalOpenAICompatProvider } from "./llmProvider";
import { type Plan, ProviderError } from "./plan";

export type AiCapability = "text" | "vision";

export interface RouterOptions {
  settings: AiSettings;
  cloudAllowed: boolean;
  local?: LLMProvider;
  cloud?: LLMProvider;
}

/** All AI provider selection lives here. Nothing else may call CloudProvider. */
export class ProviderRouter implements LLMProvider {
  private readonly local: LLMProvider;
  private readonly cloud: LLMProvider;

  constructor(private readonly options: RouterOptions) {
    this.local = options.local ?? new LocalOpenAICompatProvider({
      endpoint: options.settings.localEndpoint,
      modelId: options.settings.localModel,
      contextSize: options.settings.localContextSize,
      timeoutMs: options.settings.localTimeoutMs,
      apiKey: options.settings.localApiKey || undefined,
    });
    this.cloud = options.cloud ?? new CloudProvider({
      proxyUrl: options.settings.cloudProxyUrl,
      proxyToken: options.settings.cloudProxyToken,
      modelId: options.settings.cloudModel,
      timeoutMs: options.settings.cloudTimeoutMs,
    });
  }

  private ensureConsent(): void {
    if (!this.options.cloudAllowed) throw new ProviderError("consent-required", "Cloud AI needs your consent before any page data is sent.");
  }

  private async route<T>(capability: AiCapability, localCall: () => Promise<T>, cloudCall: () => Promise<T>): Promise<T> {
    const { mode } = this.options.settings;
    if (mode === "local") return localCall(); // hard gate: no cloud branch is reachable.
    if (mode === "cloud") { this.ensureConsent(); return cloudCall(); }
    if (capability === "vision") { this.ensureConsent(); return cloudCall(); }
    try {
      return await localCall();
    } catch (localError) {
      // Hybrid only reaches cloud after a local failure and explicit consent.
      if (!this.options.cloudAllowed) throw localError;
      return cloudCall();
    }
  }

  generateStructured(opts: GenerateStructuredOpts): Promise<Plan> {
    return this.route("text", () => this.local.generateStructured(opts), () => this.cloud.generateStructured(opts));
  }

  generateText(opts: GenerateTextOpts): Promise<string> {
    return this.route("text", () => this.local.generateText(opts), () => this.cloud.generateText(opts));
  }

  analyzeImage(opts: AnalyzeImageOpts): Promise<unknown> {
    return this.route("vision", async () => { throw new ProviderError("unknown", "Local AI does not support image analysis."); }, async () => {
      if (!this.cloud.analyzeImage) throw new ProviderError("unknown", "Cloud provider does not support image analysis.");
      return this.cloud.analyzeImage(opts);
    });
  }

  testConnection(): Promise<ConnectionStatus> {
    return this.options.settings.mode === "cloud" ? this.cloud.testConnection() : this.local.testConnection();
  }
}
