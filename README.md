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

## AI setup (local, cloud, hybrid)

The AI assistant lives in Chrome's **side panel**: click the toolbar icon → **Open AI assistant**. Type a request ("make the text larger, keep code colours"). It previews on the page; then you choose **Apply**, **Discard**, **Undo** or **Save as profile**. Saved settings always apply with zero AI calls.

### Local model (llama.cpp, default)

1. Build or install llama.cpp with CUDA (for an NVIDIA GPU such as an RTX 4050), so `llama-server` is on your PATH.
2. Start a model with every layer on the GPU:
   ```bash
   llama-server -m qwen/qwen2.5-coder-7b-instruct-q4_k_m.gguf -ngl 99 -c 8192 --jinja --port 8080
   ```
   On a 6 GB GPU, a ~4B instruct model at Q4_K_M (e.g. Qwen3.5-4B or Gemma 4 E4B) is faster and leaves room for context. Compare candidates with the eval below.
3. In **Settings → AI**, keep mode **Local only** and click **Test local connection**.

### Cloud (Gemini or Claude, through the local proxy)

```bash
cp server/.env.example server/.env   # PROXY_TOKEN + GEMINI_API_KEY and/or ANTHROPIC_API_KEY
npm run proxy
npm run smoke                        # proves each backend returns valid structured JSON
```
In **Settings → AI**, pick **Hybrid** (local first, cloud only after asking you) or **Cloud**. Choose Gemini or Claude, paste the proxy token, and click **Test cloud proxy**. **Demo mode** uses built-in rules and no model at all.

### Measure a model before the demo

```bash
npm run eval:planner -- --target local                     # llama-server on :8080
npm run eval:planner -- --target cloud --backend anthropic --token <PROXY_TOKEN>
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
