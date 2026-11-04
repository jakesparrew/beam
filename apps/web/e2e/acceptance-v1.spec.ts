/**
 * The V1 acceptance checklist (proposal section 12) as a Playwright spec.
 * Shell written by platform-P7 (Wave 0): every item is a `test.fixme` until platform-P12 (V1
 * acceptance spec and seam tests) implements it against the demo seed.
 */
import { expect, test } from "@playwright/test";
import { sql } from "drizzle-orm";
import { expectAccessible } from "./support/a11y";
import { closeE2eDb, e2eRows } from "./support/db";

test.afterAll(async () => {
  await closeE2eDb();
});

test.describe("V1 acceptance", () => {
  test.describe("Core", () => {
    // site-P2: the customer journey starts on the public site; the stable event link sends a
    // visitor without a session through the portal sign-in back to the booking page.
    test("A visitor starts on the public site and reaches booking through sign-in", async ({ page }) => {
      const home = await page.goto("/nl");
      expect(home?.status()).toBe(200);
      await expectAccessible(page);
      const [event] = await e2eRows<{ id: string }>(sql`
        select id from sessions where kind = 'event' and status = 'open' and starts_at > now() order by starts_at limit 1`);
      expect(event, "an upcoming seeded event session").toBeTruthy();
      await page.goto(`/nl/events/${event!.id}`);
      const tickets = page.locator('a[data-action="tickets"], a[data-action="waitlist"]').first();
      if ((await page.locator("[data-event]").count()) > 0) await tickets.click();
      await expect(page).toHaveURL((url) => url.pathname === "/nl/account/login" && url.searchParams.get("returnTo") === `/nl/account/book/${event!.id}`);
    });
    // Completed by platform-P12 once booking and commerce checkout are merged (it continues from the test above).
    // booking-P6 covers "customer can book, pay and cancel" and "administrator can change a booking" in
    // e2e/booking.spec.ts ("customer portal" and "V1 acceptance (booking)").
    test.fixme("A customer can register, book, pay and cancel", async () => {});
    test.fixme("The package balance updates", async () => {});
    test.fixme("The member discount applies automatically", async () => {});
    test.fixme("An administrator can change a booking", async () => {});
    test.fixme("The CRM shows the activity", async () => {});
    test.fixme("Reports reflect the transaction", async () => {});
    test.fixme("Data can be exported", async () => {});
  });

  test.describe("Email", () => {
    test.fixme("Late-entry reminders are skipped", async () => {});
    test.fixme("An unsubscribe stops marketing within 15 minutes", async () => {});
    test.fixme("Hard bounces are suppressed", async () => {});
    test.fixme("Lead, customer and member content blocks display correctly", async () => {});
  });

  test.describe("Assessment", () => {
    test.fixme("A weighted, branched assessment works", async () => {});
    test.fixme("An existing customer record is updated", async () => {});
    test.fixme("A result does not create newsletter consent", async () => {});
    test.fixme("Sensitive free text is excluded from AI", async () => {});
  });

  test.describe("Waitlist", () => {
    // booking-P6: covered in e2e/booking.spec.ts › "V1 acceptance (booking)" (second seat, claim
    // window expiry, protected confirmed seat); scenario 4 is e2e/scenario-4-seat-claim.spec.ts.
    test.fixme("The same person cannot take a second seat", async () => {});
    test.fixme("The claim window expires correctly", async () => {});
    test.fixme("A confirmed seat is protected", async () => {});
  });

  test.describe("GDPR", () => {
    test.fixme("Export works", async () => {});
    test.fixme("Deletion propagates", async () => {});
    test.fixme("Consent history is kept", async () => {});
    test.fixme("Suppression survives an import", async () => {});
  });
});
