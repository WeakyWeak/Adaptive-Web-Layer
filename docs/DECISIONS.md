# Decisions

P00: Using plain multi-entry Vite config (no vite-plugin-chrome-extension) — avoids known MV3 service-worker issues with that plugin; trade-off is manual manifest copy via public/ dir.
P00: Popup queries content script directly (not via background) — saves one message hop; background still has the proxy path for cases where popup doesn't have activeTab.
P00: Icon PNG generated programmatically via Python + zlib — no external tooling required for placeholder assets.
P00: Fixtures served by npx serve (no extra install) — zero-config, reliable for static files.
P00: Vitest uses node environment (not jsdom) for message schema tests — avoids DOM mock complexity; UI tests deferred to later phases.
P00: E2e uses chromium.launchPersistentContext (not browser.newPage) — required by Playwright for extension testing per their docs.
