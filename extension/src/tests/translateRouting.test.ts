// Translation is cloud-only (Sarvam through the proxy): the router must never
// reach it in local mode, and needs consent elsewhere. Uses the real
// CloudProvider with fetch spied on, so "no request" really means no request.

import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderRouter } from "../shared/providerRouter";
import { defaultSettings, type AiSettings, type CloudConsent } from "../shared/settings";

const ai = (mode: AiSettings["mode"]): AiSettings => ({ ...defaultSettings().ai, mode, cloudProxyToken: "token" });
const translate = (mode: AiSettings["mode"], consent: CloudConsent) =>
  new ProviderRouter({ settings: ai(mode), consent }).translate({ text: "Copy [[1]] into the box.", source: "en-IN", target: "hi-IN" });

afterEach(() => vi.unstubAllGlobals());

describe("translation routing", () => {
  it("local mode makes no proxy or Sarvam request, even with consent", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(translate("local", "allow")).rejects.toMatchObject({ code: "unsupported" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("hybrid mode asks for consent first and sends nothing until then", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(translate("hybrid", "pending")).rejects.toMatchObject({ code: "consent-required" });
    await expect(translate("cloud", "deny")).rejects.toMatchObject({ code: "consent-denied" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("with consent, posts the masked chunk to the proxy's /v1/translate", async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ text: "[[1]] को बॉक्स में कॉपी करें।", modelId: "sarvam-translate:v1" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    await expect(translate("hybrid", "allow")).resolves.toBe("[[1]] को बॉक्स में कॉपी करें।");
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8787/v1/translate");
    expect(JSON.parse(String(init.body))).toEqual({ text: "Copy [[1]] into the box.", source: "en-IN", target: "hi-IN" });
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer token");
  });

  it("maps proxy failures to typed errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { code: "not_configured", message: "SARVAM_API_KEY is not set in server/.env." } }), { status: 503 })));
    await expect(translate("cloud", "allow")).rejects.toMatchObject({ code: "not-configured" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { code: "rate_limited", message: "quota" } }), { status: 429 })));
    await expect(translate("cloud", "allow")).rejects.toMatchObject({ code: "rate-limit" });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("connection refused"); }));
    await expect(translate("cloud", "allow")).rejects.toMatchObject({ code: "proxy-down" });
  });
});
