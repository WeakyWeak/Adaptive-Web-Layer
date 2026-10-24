# Adaptive Web Layer

**Any website, adapted to how you read.** A Chrome extension (Manifest V3) where a local AI drafts changes to the page, code measures them, and an optional cloud AI reviews them. You see every change with its reason, and you decide.

Built for readers with dyslexia and other reading difficulties, and for anyone who wants a page larger, calmer, darker or less cluttered.

- **Models return settings, never code.** Every change is one of 25+ bounded, reversible operations: font, size, spacing, width, theme, tint, colours, motion, and hiding, dimming or highlighting page blocks.
- **Code is the referee.** Each AI draft is previewed and measured. Any change that lowers the readability score, hides the article, or isn't called for is undone automatically.
- **Private by default.** The planner runs on your own GPU (llama.cpp). The cloud is used only in Hybrid or Cloud mode, after you allow it for that site.
- **Dyslexia first, without overclaiming.** A reading-fit test measures which settings help *you*. The extension never claims to treat dyslexia or make a site WCAG-compliant.

## What it does

| Feature | Where | What it does |
|---|---|---|
| **Ask AI to adapt this page** | Side panel | Type a request ("bigger text, more spacing, keep the code colours"). You get a preview, then **Apply**, **Discard**, **Undo** or **Save as my profile**. |
| **Fix this page** (Alt+Shift+F) | Side panel | Fixes the problems the inspector measured: contrast, text size, line height, sticky bars, link styling. |
| **Clean this page** | Side panel | Hides cookie banners, pop-ups, promos and recommendation rails, even when class names are random. The article and navigation are never hidden. |
| **Inspect** | Side panel | A readability score from 0 to 100, based on 12 measured checks, with each finding outlined on the page. A **dyslexia lens** adds checks for justified text, italics, all caps, long sentences, long words and glare. |
| **Understand this page** | Side panel | TL;DR, glossary, Explain simply, Define, and English → Hindi translation (Sarvam). Code, links and names are kept intact. |
| **Reading views** | Side panel | **Plain reading view**: the page's own text in your settings, no AI. **Dyslexia reading view**: a checked rewrite with a 3-line summary first. |
| **Reading support** | Side panel, Options | **Find my reading settings**: a 5-minute timed reading-fit test with no AI. **Describe how reading feels**: your description becomes a starting profile. |
| **Quick settings and profiles** | Popup, Options | Typography, Smart dark, background tint, focus mode, calmer motion, and per-site rules. Saved settings apply on later visits with zero AI calls. |

Every AI run is **supervised**:
1. The local model drafts.
2. Code measures the draft and undoes regressions.
3. In **Hybrid** mode, a cloud model reviews a marked screenshot and removes mistakes or adds missed fixes.
4. The panel shows each step, the score before → draft → final, and a ledger of every change: kept, removed, added or undone, with the reason.

## Measured results

These numbers come from runs of the real extension and models, 22–24 Oct 2026. The local planner is Qwen2.5-Coder-7B Q4_K_M on a 6 GB RTX 4050 laptop GPU.

| What | Result |
|---|---|
| Planner eval (`npm run eval:planner`, 36 cases) | 100% valid plans, 35/36 correct, 0 of 5 prompt-injection pages obeyed, p50 2.3 s, p95 5.5 s |
| Clean this page, block choice (6 cluttered-page cases) | precision 1.00, recall 0.93 |
| Cloud supervisor (`npm run eval:supervisor`, 10 planted mistakes) | Gemini 3.5 Flash-Lite caught 10/10 and 9/10 (two runs, 1 false alarm each), p50 1.4 s. The local model reviewing itself caught 4/10, with 25 false alarms. |
| Describe how reading feels (`npm run eval:describe`) | 12/12 |
| "Fix this page" on real sites, local model only | GeeksforGeeks 72 → 92, MDN 85 → 100, Wikipedia 88 → 93, NHS 92 → 97, W3Schools 59 → 69; 7–18 s per run |
| Tests | 403 unit, 10 proxy, 25 browser (Playwright) |

The score is the extension's own readability measurement, not a WCAG audit.

## Quick start

Requirements: Node 18+, npm 9+, Chrome. For local AI you also need [llama.cpp](https://github.com/ggml-org/llama.cpp) (`llama-server`) and a GGUF model; a 6 GB GPU runs a 7B Q4 model.

```bash
npm install          # root + workspaces
npm run build        # → extension/dist/
```

Load the extension:
1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and choose `extension/dist/`.
3. Pin the toolbar icon, then open the AI tools with **Open AI assistant** (side panel).

Without any model, **Settings → AI → Demo mode** uses built-in rules. Saved settings, Inspect, the plain reading view and the reading-fit test never need AI.

## AI setup: Local, Cloud or Hybrid

| Terminal | Command | Port | Needed for |
|---|---|---|---|
| 1 | `npm run llm` | 8080 | **Local** and **Hybrid** (starts llama-server on your GPU) |
| 2 | `npm run proxy` | 8787 | **Cloud** and **Hybrid** (Gemini, Claude, OpenAI-compatible, Sarvam) |
| 3 | `npm run fixtures` | 4173 | the bundled test pages only |

`npm run llm` finds `llama-server` on your PATH, or at `~/llama.cpp/build/bin/llama-server`. It loads `qwen/qwen2.5-coder-7b-instruct-q4_k_m.gguf` with every layer on the GPU. Override it with `MODEL=… CTX=… npm run llm`.

The proxy keeps every API key out of the extension. To set it up:
1. Copy `server/.env.example` to `server/.env`.
2. Set `PROXY_TOKEN`, any long random string you choose.
3. Add at least one backend:
   - `GEMINI_API_KEY` (free tier; the default reviewer);
   - `ANTHROPIC_API_KEY` (paid API access);
   - any OpenAI-compatible API, via `OPENAI_COMPAT_BASE_URL`, `OPENAI_COMPAT_API_KEY` and `OPENAI_COMPAT_MODEL`.
4. Optionally add `SARVAM_API_KEY` for English → Hindi translation.
5. Run `npm run smoke` to check the keys without the extension.

Then, in **Settings → AI**:
- **Local only**: click **Test local connection**. The extension never contacts the proxy; a browser test checks this.
- **Cloud / Hybrid**: paste the same `PROXY_TOKEN` into **Proxy token** and click **Test cloud proxy**.
  - **Cloud review** sets when Hybrid asks for a review: every draft, the first run per site, or only when unsure.
  - **Review model** picks the Gemini model.
  - Each site asks once before anything is sent to the cloud.

More detail is in [`server/README.md`](server/README.md).

## Try it on the test pages

With `npm run fixtures` running:

| Page | Try |
|---|---|
| `http://localhost:4173/dyslexia-hard.html` | Profile **Dyslexia-friendly start**, then **Inspect** with the dyslexia lens |
| `http://localhost:4173/clutter.html` | **Clean this page** |
| `http://localhost:4173/obfuscated-clutter.html` | **Clean this page** in Hybrid mode: random class names, no roles, a cross-site ad frame |
| `http://localhost:4173/a11y-issues.html` / `a11y-clean.html` | **Inspect**: planted problems vs the same content scoring 100 |
| `http://localhost:4173/long-article.html` | **TL;DR**, **Show glossary**, **Plain reading view** |
| `http://localhost:4173/bilingual.html` | Select a paragraph → ✨ Understand → Translate |
| `http://localhost:4173/smart-header.html` | Smart dark on a brand-coloured header and gradient hero |
| `http://localhost:4173/motion-autoplay.html` | Calmer motion: animation, parallax, autoplay video |
| `http://localhost:4173/prompt-injection.html` | Instructions aimed at the AI are treated as page text |

Other pages: `docs-bright`, `article-sidebars`, `dashboard-dense`, `code-highlight`, `responsive-dynamic`, `native-dark`, `page-builder-article`, `scroll-lock`.

## Measure models yourself

```bash
npm run eval:planner -- --target local                       # valid plans, accuracy, injection, latency, block precision/recall
npm run eval:planner -- --target cloud --backend gemini --model gemini-3.5-flash-lite --token <PROXY_TOKEN>
npm run eval:supervisor -- --target cloud --token <PROXY_TOKEN> # does the reviewer catch planted mistakes?
npm run eval:supervisor -- --target local                    # the local model as its own reviewer, for comparison
npm run eval:comprehension -- --target local                 # TL;DR, glossary, explain, define, translate, injection
npm run eval:describe -- --target local                      # "Describe how reading feels" → starting profile
```

Each run prints a summary and writes a JSON report to `extension/eval/results/`.

## Tests

```bash
npm run typecheck      # extension + server
npm test               # Vitest (extension) + node:test (server)
npm run build && npm run fixtures &   # then:
npm run e2e            # Playwright, loads the built extension in Chromium
```

## How it works

- **Operation registry.** Every feature is an operation with Zod-bounded parameters and a revert handle, applied through one managed stylesheet. Plans can only name these operations and the page blocks found in the snapshot.
- **Plan = settings patch.** The model's JSON schema is generated from the same Zod types (`extension/src/shared/aiFields.ts`). Replies are validated, retried once if invalid, and checked by code rules.
- **Jobs.** Each AI run is a job in the MV3 service worker, stored in `chrome.storage.session` with keepalive and streaming, so it survives the side panel closing.
- **One router.** `ProviderRouter` is the only path to the cloud and enforces local-only mode and per-site consent.
- **Safety.** No `eval`, no `new Function`, and no model-generated code runs anywhere. Page text is treated as data. Text is rendered with `textContent` inside Shadow DOM.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) and [`docs/DECISIONS.md`](docs/DECISIONS.md) for the details and the reasoning.

## Project structure

```
adaptive-web-layer/
├── extension/          Chrome extension (Vite, React, TypeScript strict, Zod)
│   ├── src/
│   │   ├── background/ MV3 service worker: AI jobs, planner, supervisor, router
│   │   ├── content/    content script: operations, inspector, snapshot, overlays
│   │   ├── sidepanel/  AI assistant, Understand, Inspect, Reading support
│   │   ├── popup/      quick settings and profile switch
│   │   ├── options/    settings, profiles, site rules, reading-fit test
│   │   ├── fit/        reading-fit test UI
│   │   ├── shared/     schemas, settings, registry, scoring
│   │   └── tests/      unit tests (Vitest)
│   ├── e2e/            browser tests (Playwright)
│   ├── eval/           eval cases (results are git-ignored)
│   └── scripts/        eval runners
├── server/             localhost proxy for Gemini / Claude / OpenAI-compatible / Sarvam
├── fixtures/           static test pages (+ serve.mjs)
├── scripts/            start-llm.sh
└── docs/               ARCHITECTURE.md, DECISIONS.md
```

## Known limits

- The dyslexia lens and the reading-fit passages are English only.
- The dyslexia reading view covers about the first 14,000 characters of a page, and very long pages take a while on a local model.
- Clean this page on heavy page-builder sites can still pick a wrong block. Everything is previewed first and undoable.
- Cloud review depends on the provider's quota. Gemini free-tier reviews fall back to Flash-Lite, then to on-device checks.
- Local mode needs a GPU that can run a 7B model; Demo mode works without one.

## Credits

[llama.cpp](https://github.com/ggml-org/llama.cpp) (MIT) · Qwen2.5-Coder (Apache 2.0) · Gemini API · Sarvam API · Atkinson Hyperlegible, Lexend and OpenDyslexic fonts (SIL Open Font License) · Vite, React, Zod, Vitest, Playwright.

Research behind the dyslexia features: Zorzi et al. 2012 (PNAS), Wallace et al. 2022 (ACM TOCHI), Rello & Bigham 2017, Rello & Baeza-Yates, and the British Dyslexia Association Style Guide.

Team Bhaukaal: Tanmay Verma and Shaurya Gupta. AgentOps 2026, MIT Bengaluru.
