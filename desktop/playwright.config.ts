import { defineConfig } from "@playwright/test";
import { tmpdir } from "node:os";
import { join } from "node:path";
const port = Number(process.env.POMO_UI_TEST_PORT ?? 1420);
const baseURL = `http://127.0.0.1:${port}`;
export default defineConfig({
  testDir: ".",
  testMatch: "ui.spec.ts",
  fullyParallel: true,
  outputDir: join(tmpdir(), "pomo-restbank-ui-tests-20261107"),
  use: {
    baseURL,
    channel: "msedge",
    viewport: { width: 680, height: 850 },
  },
  webServer: {
    command: `npm run dev:frontend -- --port ${port} --strictPort`,
    url: baseURL,
    reuseExistingServer: false,
  },
});
