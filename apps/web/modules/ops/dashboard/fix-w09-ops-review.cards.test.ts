/**
 * Review finding 5 (ops rule 29): the webinar-leads card reads the keys the `webinar_tool`
 * history applier writes (`title`, `starts_at`), not only the generic history keys.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@beam/db";
import { importedHistory } from "@beam/db/schema";
import { RETENTION_DEFAULTS } from "@beam/core/ops";
import { createTestDb } from "@beam/db/testing";
import { resetRuntime, staffActor } from "@/lib/testing";
import type { OpsReadCtx } from "../reports/registry";
import { getActionDashboard } from "./queries";
import { ago, ahead, makeCustomer, makeImportedRegistration } from "./ops-p3.fixtures";

let h: DbHandle;
beforeAll(async () => {
  h = await createTestDb();
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});

const ctx = (): OpsReadCtx => ({ tx: h.db, actor: staffActor({ permissions: ["reports.read", "tasks.all"] }), now: new Date(), locale: "en" });

async function rows() {
  const cards = await getActionDashboard(ctx(), { expand: "webinar_leads_not_booked" });
  return cards.find((c) => c.key === "webinar_leads_not_booked")?.rows ?? [];
}

/** A registration with the data the `webinar_tool` applier stores (appliers/history.ts). */
async function toolRegistration(registeredAt: Date, startsAt: Date, title: string) {
  // The shared fixture gives the import; its own row belongs to a person outside the assertions.
  const other = await makeCustomer(h.db);
  const { importId } = await makeImportedRegistration(h.db, { personId: other.id, registeredAt: ago(400) });
  const p = await makeCustomer(h.db);
  const [reg] = await h.db
    .insert(importedHistory)
    .values({
      personId: p.id,
      importId,
      source: "webinar_tool",
      kind: "webinar_registration",
      occurredAt: registeredAt,
      externalId: randomUUID(),
      data: { provider: "webinargeek", external_webinar_id: "wg-1", title, starts_at: startsAt.toISOString() },
    })
    .returning();
  return { person: p, reg: reg! };
}

describe("webinar_leads_not_booked with webinar_tool data (review finding 5)", () => {
  it("lists a lead who registered before the window for a webinar held inside it, with the webinar title", async () => {
    const { person } = await toolRegistration(ago(RETENTION_DEFAULTS.webinar_lead_window_days + 6), ago(3), "Cold exposure live");
    const row = (await rows()).find((r) => r.personId === person.id);
    expect(row).toBeDefined();
    expect(row!.params.webinar).toBe("Cold exposure live");
  });

  it("does not list a lead registered recently for a webinar that is still to come", async () => {
    const { person } = await toolRegistration(ago(5), ahead(60), "Future webinar");
    expect((await rows()).map((r) => r.personId)).not.toContain(person.id);
  });
});
