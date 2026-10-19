# Adaptive Web Layer local proxy

This server binds only to `127.0.0.1`. Copy `server/.env.example` to `server/.env`, fill in the values, then run `npm run dev --workspace=server` from the repository root. The proxy always loads `server/.env`, regardless of where the command is launched.

To find `ALLOWED_ORIGIN`, open `chrome://extensions`, enable **Developer mode**, and copy the extension ID. Its origin is `chrome-extension://<extension-id>`.

`PROXY_TOKEN` authorizes requests to this localhost proxy only. It is not a Gemini or Sarvam key and cannot grant access to either provider by itself. Provider keys remain in `server/.env`; no provider key is sent to or bundled in the extension.

The proxy does not log request bodies, images, prompts, tokens, or keys. It applies a body-size limit, a per-minute local rate limit, request timeouts, bearer authentication, and the configured CORS origin.
