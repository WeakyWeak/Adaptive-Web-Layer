# Adaptive Web Layer local proxy

Holds cloud API keys and forwards structured requests to **Gemini** or **Claude**. It binds only to `127.0.0.1`.

```bash
cp server/.env.example server/.env   # fill in PROXY_TOKEN and at least one provider key
npm run proxy                        # from the repo root (= npm run dev --workspace=server)
npm run smoke                        # live check that each configured backend returns valid JSON
```

Then in the extension, open **Settings → AI**. Paste the same `PROXY_TOKEN`, pick the provider (Gemini or Claude), and press **Test cloud proxy**.

- `PROXY_TOKEN` authorizes requests to this localhost proxy only. It is not a provider key. Provider keys never reach the extension.
- CORS accepts `chrome-extension://` origins and rejects every web origin. Set `ALLOWED_ORIGIN` to pin specific extension ids (see `chrome://extensions` with Developer mode on).
- `/v1/analyze` streams NDJSON: `{"type":"ping"}` every 5 s, then exactly one `{"type":"result",...}` or `{"type":"error",...}` line. This keeps the extension's service worker alive during slow model calls.
- Claude uses the official `@anthropic-ai/sdk` with structured outputs (`output_config.format`). Effort comes from `ANTHROPIC_EFFORT` (default `low`). Models that support it get the server-side refusal fallback.
- The proxy does not log request bodies, images, prompts, tokens or keys. It enforces a 1 MB body limit, 30 requests/minute, bearer auth and request timeouts.
