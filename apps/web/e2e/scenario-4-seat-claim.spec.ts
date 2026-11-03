/**
 * Scenario 4: seat claim expiry (proposal section 11).
 * Shell written by platform-P7 (Wave 0): each checklist item is a `test.fixme` until the owning
 * module (booking, architecture section 11) implements the scenario and turns it into a test.
 */
import { test } from "@playwright/test";

test.describe("Scenario 4: seat claim expiry (proposal section 11)", () => {
  test.fixme("A seat moves waiting -> offered (with expiry) -> confirmed or released", async () => {});
  test.fixme("The offer link is personal, single-use and stops working at expiry", async () => {});
  test.fixme("Expiries are checked every minute and the seat is offered to the next eligible person", async () => {});
  test.fixme("No automation can remove a confirmed seat", async () => {});
  test.fixme("The same person cannot take a second seat", async () => {});
});
