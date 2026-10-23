# Adaptive Web Layer

A Chrome extension (Manifest V3) that adapts websites to your reading and appearance preferences. The browser adapts to you — not the other way around.

## Requirements

- Node 18+ / npm 9+
- Chrome (for loading unpacked extension)
- Git

## Install and Build

```bash
# Install all dependencies (root + workspaces)
npm install

# Build the extension
npm run build
# → creates extension/dist/
```

## Load the Extension Unpacked

1. Open Chrome → `chrome://extensions`
2. Enable **Developer mode** (top right toggle)
3. Click **Load unpacked**
4. Select the `extension/dist/` folder
5. The extension icon appears in the toolbar

## Run Fixture Pages

```bash
npm run fixtures
# → serves fixture pages at http://localhost:4173
```

Pages:
- http://localhost:4173/docs-bright.html — bright technical docs
- http://localhost:4173/fixtures/docs-bright.html — same page from the repository-relative fixture path
- http://localhost:4173/article-sidebars.html — article with distracting sidebars
- http://localhost:4173/dashboard-dense.html — dense dashboard tables
- http://localhost:4173/code-highlight.html — syntax-highlighted code
- http://localhost:4173/responsive-dynamic.html — responsive + dynamic JS content
- http://localhost:4173/native-dark.html — native dark theme and fixed/sticky controls
- http://localhost:4173/motion-autoplay.html — CSS and script animation, parallax, an autoplay video and a video started by script
- http://localhost:4173/smart-header.html — brand-colour header, gradient hero, sticky bar that turns solid and a banner added late (try Smart Dark)
- http://localhost:4173/long-article.html — jargon-heavy explainer (try **TL;DR** and **Show glossary** in the side panel)
- http://localhost:4173/bilingual.html — prose with code, links and identifiers, plus an instruction aimed at AI (select a paragraph → ✨ Understand → Translate)
- http://localhost:4173/a11y-issues.html — planted accessibility and readability problems (side panel → **Inspect this page**)
- http://localhost:4173/a11y-clean.html — the same content with none of them (scores 100)
- http://localhost:4173/clutter.html — article under a cookie banner, newsletter pop-up, promo bar and "Recommended" rail (try **Clean this page** in the side panel)
- http://localhost:4173/obfuscated-clutter.html — the same kinds of clutter with random class names, no roles and nothing fixed, plus a cross-site ad frame (try **Clean this page** in hybrid mode and read the review)

## AI setup (local, cloud, hybrid)

The AI assistant lives in Chrome's **side panel**: click the toolbar icon → **Open AI assistant**. Type a request ("make the text larger, keep code colours"), or press **Fix this page** / **Clean this page** (or Alt+Shift+F on any page). It previews on the page; then you choose **Apply**, **Discard**, **Undo** or **Save as profile**. Saved settings always apply with zero AI calls.

Every AI run is **supervised**: the local model drafts, code measures the draft and undoes anything that makes the page measurably worse, and in **Hybrid** mode a cloud model reviews the draft (removing mistakes, adding what was missed). The panel shows each step, the readability score before → draft → final, and every change as kept, removed, added or undone, with the reason.

### What to run (one terminal each)

| Terminal | Command | Port | Needed for |
|---|---|---|---|
| 1 | `npm run fixtures` | 4173 | the test pages only |
| 2 | `npm run llm` | 8080 | **Local** and **Hybrid** modes (starts llama-server on your GPU) |
| 3 | `npm run proxy` | 8787 | **Cloud** and **Hybrid** modes (Gemini / Claude) |

`npm run llm` finds `llama-server` on your PATH or at `~/llama.cpp/build/bin/llama-server` and loads `qwen/qwen2.5-coder-7b-instruct-q4_k_m.gguf` with every layer on the GPU. Override with `MODEL=… CTX=… npm run llm`.

The proxy reads `server/.env` (copy `server/.env.example`). It needs `PROXY_TOKEN` (any long random string you choose) and at least one cloud backend: `GEMINI_API_KEY` (free tier; the default reviewer), `ANTHROPIC_API_KEY` (a paid API key; a Claude Pro subscription does not include API access), or any OpenAI-compatible API via `OPENAI_COMPAT_BASE_URL` / `OPENAI_COMPAT_API_KEY` / `OPENAI_COMPAT_MODEL`. `SARVAM_API_KEY` enables English → Hindi translation. `npm run smoke` checks the keys without the extension (one fixed test sentence per service, plus a tiny test image for the reviewer's model).

Then in **Settings → AI**:
- **Local only**: click **Test local connection**.
- **Cloud / Hybrid**: pick the provider, paste the same `PROXY_TOKEN` into **Proxy token**, and click **Test cloud proxy**. **Cloud review** sets when hybrid asks the cloud to review (every draft, first run per site, or only when the local draft looks unsure); **Review model** picks the Gemini model for reviews.
- **Demo mode** uses built-in rules and no model at all.

### Measure a model before the demo

```bash
npm run eval:planner -- --target local                     # llama-server on :8080 (also scores element precision/recall)
npm run eval:planner -- --target cloud --backend gemini --model gemini-3.5-flash-lite --token <PROXY_TOKEN>
npm run eval:comprehension -- --target local               # TL;DR, glossary, explain, define, local translation, injection (P08 fixtures)
npm run eval:supervisor -- --target cloud --token <PROXY_TOKEN>   # does the reviewer catch planted draft mistakes? (P10)
npm run eval:supervisor -- --target local                  # the local model as its own reviewer, for comparison
```
It prints the valid-plan rate, accuracy on 25 cases (including prompt-injection pages) and p50/p95 latency, and writes a report to `extension/eval/results/`.

## Run Tests

```bash
# Unit tests (Vitest)
npm test

# Typecheck only
npm run typecheck

# E2E tests (Playwright, requires built extension + fixtures server)
npm run build && npm run fixtures &
npm run e2e
```

## Development

```bash
npm run dev
# → watches extension/src and rebuilds on change
```

## Project Structure

```
adaptive-web-layer/
├── extension/          # Chrome extension source + build
│   ├── src/
│   │   ├── background/ # MV3 service worker
│   │   ├── content/    # Content script (document_start)
│   │   ├── popup/      # React popup UI (quick settings)
│   │   ├── sidepanel/  # React side panel (AI assistant)
│   │   ├── options/    # React options page
│   │   ├── shared/     # Shared types, schemas, utils
│   │   └── tests/      # Unit tests
│   ├── e2e/            # Playwright e2e tests
│   ├── eval/           # Planner eval cases (results git-ignored)
│   ├── scripts/        # evalPlanner.ts
│   └── dist/           # Build output (git-ignored)
├── server/             # Local proxy for Gemini / Claude (keys live in server/.env)
├── fixtures/           # Static test pages
├── docs/               # Architecture, decisions, permissions
└── phases/             # Phase instructions (git-ignored)
```
