/**
 * Smoke test of a production build on beam_dev (platform-P7). Run only by the orchestrator at
 * checkpoints; coding agents prove it compiles with `playwright test --list`.
 */
import { expect, test } from "@playwright/test";
import { expectAccessible } from "./support/a11y";

test.describe("smoke", () => {
  test("/api/health answers 200", async ({ request }) => {
    const res = await request.get("/api/health");
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { status?: string };
    expect(body.status).toBeTruthy();
  });

  test("/ redirects to /nl", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/nl\/?$/);
  });

  test("/admin without a session goes to the login page", async ({ page }) => {
    await page.goto("/admin");
    await expect(page).toHaveURL(/\/admin\/login/);
  });

  test("/nl is accessible", async ({ page }) => {
    await page.goto("/nl");
    await expectAccessible(page);
  });

  test("/admin/login is accessible", async ({ page }) => {
    await page.goto("/admin/login");
    await expectAccessible(page);
  });
});
