import { defineConfig } from "vite";
import { resolve } from "path";

// Separate build for the content script.
// MV3 content scripts are injected as classic scripts (no type="module"),
// so they CANNOT use ES module import/export syntax. They must be built as
// a self-contained IIFE with all dependencies inlined.
// This config runs AFTER the main vite.config.ts build (emptyOutDir: false).

export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: false, // Do NOT wipe the main build output
    lib: {
      entry: resolve(__dirname, "src/content/index.ts"),
      name: "AWLContent",
      formats: ["iife"],
      fileName: () => "content.js",
    },
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
  },
});
