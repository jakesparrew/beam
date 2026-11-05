import path from "node:path";
import { fileURLToPath } from "node:url";
import { FAKE_RESEND_WEBHOOK_SECRET } from "@beam/integrations/resend";
import { defineConfig, devices } from "@playwright/test";
import { config } from "dotenv";

// The same root env files as global-setup and next.config, read before the webServer env is
// built, so the server and the specs agree on every value below.
const here = path.dirname(fileURLToPath(import.meta.url));
config({ path: [path.join(here, "../../.env.local"), path.join(here, "../../.env")], quiet: true });

// Playwright against a production build on beam_dev (runbook section 3.6, BS-15).
// Only the orchestrator runs it; coding agents prove specs compile with `playwright test --list`.
const port = 3100;

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  globalSetup: "./e2e/global-setup.ts",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  retries: 1, // a spec that fails twice is a real failure (build order risk 6)
  workers: 2,
  fullyParallel: false, // tests inside one file run in order
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? `http://localhost:${port}`,
    locale: "nl-BE",
    timezoneId: "Europe/Brussels",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `pnpm start -p ${port}`, // production build made by the gate's `pnpm build`
    url: `http://localhost:${port}/api/health`,
    timeout: 120_000,
    reuseExistingServer: false,
    // merged over process.env; LOCAL_TICK_MS runs jobs in-process under next start (DR-13)
    env: {
      APP_URL: `http://localhost:${port}`,
      INTEGRATIONS: "fake",
      EMAIL_SINK: "sink@beam.be",
      LOCAL_TICK_MS: "1000",
      // site consent and marketing specs: GA4 loads only in production mode (site-P5, site-P9)
      BEAM_ANALYTICS_PRODUCTION: "1",
      // the Resend webhook route verifies the specs' signed fake webhooks (email-P4); the specs
      // sign with `process.env.RESEND_WEBHOOK_SECRET || FAKE_RESEND_WEBHOOK_SECRET`, the same value
      RESEND_WEBHOOK_SECRET: process.env.RESEND_WEBHOOK_SECRET || FAKE_RESEND_WEBHOOK_SECRET,
    },
  },
});
