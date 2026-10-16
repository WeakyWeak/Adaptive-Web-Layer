# Architecture

## Phase 0 — Foundation

The project is a Chrome Manifest V3 extension built with a plain multi-entry Vite + React + TypeScript (strict) stack. The repo is an npm workspace monorepo with two packages: `extension/` and `server/` (server added in P06).

### Extension entry points

- **background/index.ts** — MV3 service worker. Stateless by design (SW is terminated when idle). Handles `PING` and proxies `GET_PAGE_INFO` to the active tab's content script.
- **content/index.ts** — Content script at `document_start` on all URLs. Gracefully skips restricted pages. Responds to `GET_PAGE_INFO` with `{hostname, url, title}`.
- **popup/index.html** → **popup/App.tsx** — React popup. Queries the active tab for page info and displays hostname + status. Panel list (`popup/panels/index.ts`) is empty in P00; future phases push panels here without editing shared code.
- **options/index.html** → **options/OptionsApp.tsx** — React options page with 7 tab shells: Appearance & Reading, Profiles, Sites, AI, Privacy & Consent, Import/Export, Troubleshooting. All placeholders in P00.

### Shared infrastructure

- **shared/messages.ts** — Zod discriminated-union message protocol. All inter-component messaging uses `AnyMessage`; unknown messages are dropped. `parseMessage()` validates at runtime.
- **public/manifest.json** — MV3 manifest: permissions `activeTab, storage, scripting, tabs, tts`; host permissions for `localhost`.

### Build

Plain multi-entry Vite config (`vite.config.ts`). Each entry point compiles separately; background and content scripts emit as `background.js` / `content.js` (no hash) so the manifest can reference them by fixed name. React entries use HTML inputs and are processed normally.

### Testing

- Unit tests: Vitest with node environment, testing the Zod message schema.
- E2e: Playwright with persistent Chromium context loading the built extension. Smoke test verifies the service worker registers and a fixture page loads.

### Fixtures

Five self-contained static HTML pages in `fixtures/`, served by `npx serve` on port 4173. No external requests; all assets are inline SVGs or CSS.
