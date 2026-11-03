/**
 * Scenario 1: late-entry email skip (proposal section 11).
 * Shell written by platform-P7 (Wave 0): each checklist item is a `test.fixme` until the owning
 * module (automation, architecture section 11) implements the scenario and turns it into a test.
 */
import { test } from "@playwright/test";

test.describe("Scenario 1: late-entry email skip (proposal section 11)", () => {
  test.fixme("A person entering a sequence gets every step's send moment computed relative to the anchor event", async () => {});
  test.fixme("Steps whose moment has passed are logged as skipped_late_entry and never sent", async () => {});
  test.fixme("A Friday registrant for a Sunday event gets the confirmation and the day-of reminder only", async () => {});
  test.fixme("The automation log shows the skipped steps with their reason", async () => {});
});
