import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";

// Plain multi-entry Vite config for MV3 (no flaky plugins needed).
// Decision: Using plain multi-entry Vite + @vitejs/plugin-react.
// No vite-plugin-chrome-extension — avoids known MV3 service-worker issues.
// HTML entries are in extension/popup/ and extension/options/ so Vite outputs
// them as dist/popup/index.html and dist/options/index.html — matching the
// paths referenced in manifest.json.

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        popup: resolve(__dirname, "popup/index.html"),
        options: resolve(__dirname, "options/index.html"),
        background: resolve(__dirname, "src/background/index.ts"),
        content: resolve(__dirname, "src/content/index.ts"),
      },
      output: {
        // Keep entry chunks named without hashing — Chrome loads by fixed path
        entryFileNames: (chunk) => {
          if (chunk.name === "background") return "background.js";
          if (chunk.name === "content") return "content.js";
          return "assets/[name].js";
        },
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
});
