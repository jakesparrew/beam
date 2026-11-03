import { defineConfig, devices } from "@playwright/test";

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
    },
  },
});
