# Decisions

P00: Using plain multi-entry Vite config (no vite-plugin-chrome-extension) — avoids known MV3 service-worker issues with that plugin; trade-off is manual manifest copy via public/ dir.
P00: Popup queries content script directly (not via background) — saves one message hop; background still has the proxy path for cases where popup doesn't have activeTab.
P00: Icon PNG generated programmatically via Python + zlib — no external tooling required for placeholder assets.
P00: Fixtures served by npx serve (no extra install) — zero-config, reliable for static files.
P00: Vitest uses node environment (not jsdom) for message schema tests — avoids DOM mock complexity; UI tests deferred to later phases.
P00: E2e uses chromium.launchPersistentContext (not browser.newPage) — required by Playwright for extension testing per their docs.
P00: HTML entry points placed at extension/popup/ and extension/options/ (not inside src/) so Vite outputs them to dist/popup/ and dist/options/ matching manifest paths exactly.
P01: Typography defaults are neutral operations; Reset removes managed overrides so the page returns to its own styling. Font families are allowlisted in the shared settings schema to keep CSS values safe.
P01: Content-region styles wait for the document head/root when the content script runs before those nodes exist at document_start.
P02: Site rules match normalized exact hostnames by default; subdomains apply only when a rule explicitly opts in. Exact matches take precedence over matching parent rules.
P02: The four built-in profiles are protected from deletion and can be duplicated; disabled operation ids resolve to their neutral defaults before application through the shared Operation registry.
P02: Dynamic page inserts reuse the managed stylesheet; a debounced observer refreshes after added element subtrees and ignores the AWL stylesheet to avoid a mutation loop. SPA path/hash changes trigger a settings refresh.
P02: Exported settings use the versioned Zod schema, imports are capped at 1 MB and choose merge or replace, and Reset everything clears preferences back to built-in defaults.
