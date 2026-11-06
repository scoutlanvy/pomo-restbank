import { defineConfig } from "@playwright/test";
import { tmpdir } from "node:os";
import { join } from "node:path";
export default defineConfig({
  testDir: ".",
  testMatch: "ui.spec.ts",
  fullyParallel: true,
  outputDir: join(tmpdir(), "pomo-restbank-ui-tests-20261107"),
  use: {
    baseURL: "http://127.0.0.1:1420",
    channel: "msedge",
    viewport: { width: 680, height: 850 },
  },
  webServer: {
    command: "npm run dev",
    url: "http://127.0.0.1:1420",
    reuseExistingServer: false,
  },
});
