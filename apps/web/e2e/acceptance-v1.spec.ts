/**
 * The V1 acceptance checklist (proposal section 12) as a Playwright spec.
 * Shell written by platform-P7 (Wave 0): every item is a `test.fixme` until platform-P12 (V1
 * acceptance spec and seam tests) implements it against the demo seed.
 */
import { test } from "@playwright/test";

test.describe("V1 acceptance", () => {
  test.describe("Core", () => {
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
