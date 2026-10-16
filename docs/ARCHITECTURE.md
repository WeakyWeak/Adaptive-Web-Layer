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

Five self-contained static HTML pages in `fixtures/`, served by the Node built-in HTTP server on port 4173. No external requests; all assets are inline SVGs or CSS.

## Phase 1 — Settings, registry, typography

Versioned Zod settings are read and written through `shared/storage.ts`; typography resolves defaults, global preferences, the active profile, then an enabled site override. Seven bounded typography operations register target and protected-element metadata and write only to the managed `style[data-awl]` layer. Neutral defaults remove overrides so Reset restores the site’s own styling. The content script waits for a document root when injected at `document_start`, and the popup/options controls preview and save global reading preferences using bundled fonts.

## Phase 2 — Profiles, site rules, persistence, and undo

Settings now include the global enable switch, four built-in profiles, normalized exact-host site rules with optional subdomain matching, per-site profile selection and disabled operations. The popup controls global and site enablement, profile selection, temporary page undo/reset, and removing the current site rule; the options page supports profile CRUD, site rule editing, and validated 1 MB import/export with merge or replace. The content script reapplies saved settings on storage and SPA navigation changes, and debounces added-subtree observation while ignoring the managed AWL stylesheet. The service worker sets a per-tab badge when resolved typography differs from neutral defaults.

## Phase 3 — Adaptive appearance

Appearance preferences are versioned and resolve global → active profile → site rule; Night selects dark and Study selects sepia. Theme, adjustment-variable, and composed-filter operations register through the shared registry and write to the managed stylesheet. Fast uses root inversion with reinversion for media, code, controls, preserved nodes, and detected CSS-background elements; Smart maps computed surface and text colors for Light or Dark on up to 2,500 elements. Smart's theme plan includes whether the document body exists, so its palette is created on the DOM-ready pass when early content-script startup has no body. The applier compares each operation's parameters and preserves unchanged operations across SPA refreshes, including unchanged typography, preventing Smart stylesheet rewrites during scroll-driven DOM mutations. Contrast, brightness, and saturation update independent variables consumed by a valid composed filter in Light, Dark, and Sepia. A dark-site detector checks common class/data signals, color-scheme declarations, and root/body luminance regardless of the system preference. Existing-dark skipping applies to Fast inversion only; Smart can safely map a dark page without mistaking its own output for the source palette. The per-site popup and global options expose the engine selector; Smart marker attributes are restored with the theme operation. `lib/color.ts` provides CSS color parsing, alpha compositing, relative luminance, and WCAG contrast math.
