/**
 * Scenario 7: end-to-end deletion (proposal section 11).
 * Shell written by platform-P7 (Wave 0): each checklist item is a `test.fixme` until the owning
 * module (ops, architecture section 11) implements the scenario and turns it into a test.
 */
import { test } from "@playwright/test";

test.describe("Scenario 7: end-to-end deletion (proposal section 11)", () => {
  test.fixme("One deletion request starts the deletion workflow", async () => {});
  test.fixme("The person is removed or anonymised in CRM, email, webinar, assessment, waitlist and AI logs", async () => {});
  test.fixme("Deletion requests reach connected systems (Billit, mandates, Resend) through their APIs", async () => {});
  test.fixme("Invoices required by Belgian law are retained but unlinked from the marketing profile", async () => {});
  test.fixme("A minimal suppression record prevents re-import into marketing", async () => {});
  test.fixme("A confirmation report is produced and the audit trail holds no personal data", async () => {});
});
