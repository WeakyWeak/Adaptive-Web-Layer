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
- http://localhost:4173/article-sidebars.html — article with distracting sidebars
- http://localhost:4173/dashboard-dense.html — dense dashboard tables
- http://localhost:4173/code-highlight.html — syntax-highlighted code
- http://localhost:4173/responsive-dynamic.html — responsive + dynamic JS content

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
│   │   ├── popup/      # React popup UI
│   │   ├── options/    # React options page
│   │   ├── shared/     # Shared types, schemas, utils
│   │   └── tests/      # Unit tests
│   ├── e2e/            # Playwright e2e tests
│   └── dist/           # Build output (git-ignored)
├── server/             # Local proxy (added in P06)
├── fixtures/           # Static test pages
├── docs/               # Architecture, decisions, permissions
└── phases/             # Phase instructions (git-ignored)
```
