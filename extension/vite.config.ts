import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";

// Plain multi-entry Vite config for MV3.
// Decision: no vite-plugin-chrome-extension — avoids known MV3 service-worker issues.
//
// IMPORTANT: Content script is built separately via vite.content.config.ts as IIFE,
// because MV3 content scripts are classic scripts (no type="module") and cannot use
// ES module import syntax. Only the service worker (background.js) supports ESM.
//
// HTML entries live at extension/popup/ and extension/options/ so Vite outputs
// them to dist/popup/, dist/options/ and dist/sidepanel/ — matching manifest.json.

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true, // Wipe dist before main build; content build follows with emptyOutDir:false
    rollupOptions: {
      input: {
        popup: resolve(__dirname, "popup/index.html"),
        options: resolve(__dirname, "options/index.html"),
        sidepanel: resolve(__dirname, "sidepanel/index.html"),
        // P11: the reading-fit test's passage reader (an iframe inside the side panel and Options).
        fitreader: resolve(__dirname, "fitreader/index.html"),
        background: resolve(__dirname, "src/background/index.ts"),
        // content is NOT here — it is built separately as IIFE
      },
      output: {
        entryFileNames: (chunk) => {
          if (chunk.name === "background") return "background.js";
          return "assets/[name].js";
        },
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
});
