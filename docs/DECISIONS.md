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
P03: The Fast dark engine applies `invert(1) hue-rotate(180deg)` to the document root, then reinverts media, code, form controls, preserved nodes, and up to 2,500 detected CSS-background elements. Root filtering gives broad coverage without rewriting site layout rules; it can create stacking-context/containing-block side effects, so the fixed/sticky fixture check remains necessary in Chrome.
P03: Brightness, contrast, and saturation are CSS custom properties composed into one root filter chain, so independent registry operations do not replace one another. Saturation 0 is the grayscale setting.
P03: Sepia uses a small warm-color palette on page surfaces and prose rather than filtering the root, preserving images and syntax colors. Smart per-element recoloring is deferred because Fast's visual exit checks could not be completed in this environment.
P03: For the inverted dark engine, `color-scheme: light` is set before root inversion and controls are reinverted to preserve their original appearance.
P03 follow-up: Root/body darkness now detects an already-dark page regardless of the operating system theme. Pages that explicitly declare a dark theme are never Fast-inverted, even when the force option is saved, because root inversion makes those pages light; the override remains available for luminance-only detections.
P03 follow-up: Smart is selectable per site and globally. It recolors bounded page surfaces and text without root inversion, while protected media, code, and controls are excluded. Light and Sepia share one composed root filter rule so contrast, brightness, and saturation stay effective across themes.
P03 follow-up: The fixture server serves repository-relative `/fixtures/...` paths and defaults `/` to `docs-bright.html`; `FIXTURE_PORT` allows an alternate local port when the default is occupied.
P03 follow-up: Appearance operations are updated independently by parameter signature. Repeated SPA/mutation refreshes leave an unchanged Smart theme and its marker palette mounted, while Light/Sepia slider changes update only the composed filter and adjustment variables.
P03 follow-up: The composed filter is generated directly. Expanding a `none` custom property before contrast, brightness, or saturation makes the whole CSS declaration invalid in Light, Sepia, and Smart.
P03 follow-up: Smart includes body readiness in its theme plan. A document-start application with no body is replaced once at DOM-ready, then remains stable through later scroll-driven refreshes.
P03 follow-up: Existing-dark detection skips Fast only. Applying the skip to Smart caused Smart Dark to detect its own recolored palette after a dynamic class change and remove itself.
P03 follow-up: Typography is a no-op when resolved values are unchanged, so mutation refreshes do not rewrite the shared stylesheet that carries the Smart palette.
P04: Sidebar heuristics mark only inspected safe candidates before the managed stylesheet collapses them; explicit picker choices are stored as per-site robust selectors and may target otherwise protected elements only through the user’s direct action.
P04: Motion controls neutralize CSS animation, transition, smooth scrolling, parallax patterns, and autoplay media where the browser exposes them, while retaining focus-visible outlines and avoiding any attempt to simulate or suppress user-initiated playback.
P04 follow-up: Focus targets are discovered from the actual document and marked before managed CSS is applied, avoiding broad ancestor selectors that could dim the reading region; the picker’s event shield is preferred over document-level interception so site click handlers cannot win the event race.
