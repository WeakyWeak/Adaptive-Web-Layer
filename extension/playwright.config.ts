import { defineConfig, devices } from "@playwright/test";
import path from "path";

const EXTENSION_PATH = path.resolve(__dirname, "dist");

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  use: {
    // Persistent context needed to load extensions
    headless: false, // extensions don't work in headless in older Chrome; use new-headless via args
    viewport: { width: 1280, height: 720 },
  },
  projects: [
    {
      name: "chromium-extension",
      use: {
        ...devices["Desktop Chrome"],
        // Launch with extension loaded
        launchOptions: {
          headless: false,
          args: [
            `--disable-extensions-except=${EXTENSION_PATH}`,
            `--load-extension=${EXTENSION_PATH}`,
            "--no-sandbox",
            "--headless=new", // new headless mode supports extensions
          ],
        },
      },
    },
  ],
});
