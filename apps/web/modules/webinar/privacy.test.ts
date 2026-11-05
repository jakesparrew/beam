/**
 * webinar privacy (spec section 9; webinar-P3 adds the registration cases, webinar-P1's cases are
 * in `webinar-p1.privacy.test.ts`, webinar-P6 completes this file): registrations made through
 * `registerPerson` are exported with the title in the registration's locale, status, source,
 * dates and UTM, never with the token hash; erasure deletes them, after which the personal link
 * no longer resolves and the merge fields return null (edge case 18). Consent records written at
 * registration belong to crm's erasure, not this module's.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle, Tx } from "@beam/db";
import { consentRecords, webinarRegistrations } from "@beam/db/schema";
import { createTestDb, makePerson, makeUser } from "@beam/db/testing";
import { NotFoundError, eq } from "@/lib/ctx";
import { makeCtx } from "@/lib/testing";
import { GDPR_REGISTRY } from "@/registry/privacy.generated";
import { getAccessUrl } from "./api";
import { mergeFields } from "./merge-fields";
import { privacy } from "./privacy";
import { cancelRegistration, registerPerson } from "./server/registration";
import { makeWebinar, WEBINAR_TITLE } from "./test/factories";

let h: DbHandle;
let ownerId: string;
beforeAll(async () => {
  h = await createTestDb();
  ownerId = (await makeUser(h.db)).id;
}, 120_000);
afterAll(() => h.close());

describe("registrations in export and erase (section 9.1)", () => {
  it("exports the registrations without tokens; erase deletes them and the link stops resolving", async () => {
    expect(GDPR_REGISTRY.webinar).toBe(privacy);
    const ctx = makeCtx(h.db, { actor: { kind: "public" } });
    const tx = h.db as unknown as Tx;
    const p = await makePerson(h.db);
    const live = await makeWebinar(h.db, { ownerUserId: ownerId }, { published: true });
    const od = await makeWebinar(h.db, { ownerUserId: ownerId, mode: "on_demand", startsAt: null }, { published: true });
    const a = await registerPerson(tx, ctx, { webinarId: live.id, personId: p.id, source: "site", locale: "fr-BE", utm: { source: "newsletter" }, consents: { events: true }, wordingVersion: "v1" });
    const b = await registerPerson(tx, ctx, { webinarId: od.id, personId: p.id, source: "portal", locale: "en", utm: {} });
    await cancelRegistration(tx, ctx, b.registrationId, "customer");

    const exported = await h.db.transaction((t) => privacy.export(t, p.id));
    const regs = exported["webinar/registrations.json"] as Array<Record<string, unknown>>;
    expect(regs).toHaveLength(2);
    expect(regs.find((r) => r.webinar_title === WEBINAR_TITLE["fr-BE"])).toMatchObject({ webinar_mode: "live", registered_mode: "live", status: "registered", source: "site", locale: "fr-BE", utm: { source: "newsletter" }, cancelled_at: null });
    expect(regs.find((r) => r.webinar_title === WEBINAR_TITLE.en)).toMatchObject({ webinar_mode: "on_demand", registered_mode: "on_demand", status: "cancelled", source: "portal" });
    const text = JSON.stringify(exported);
    const [row] = await h.db.select().from(webinarRegistrations).where(eq(webinarRegistrations.id, a.registrationId));
    expect(text).not.toContain(row!.accessTokenHash);
    expect(text).not.toContain("/w/");

    expect(await getAccessUrl(h.db, a.registrationId, "fr-BE")).toContain(`/fr/w/${a.registrationId}.1.`);
    const report = await h.db.transaction((t) => privacy.erase(t, p.id));
    expect(report.find((r) => r.table === "webinar_registrations")).toEqual({ table: "webinar_registrations", rows: 2, action: "deleted" });
    expect(await h.db.select().from(webinarRegistrations).where(eq(webinarRegistrations.personId, p.id))).toEqual([]);
    await expect(getAccessUrl(h.db, a.registrationId, "fr-BE")).rejects.toBeInstanceOf(NotFoundError);
    expect(await mergeFields.access_url({ tx: h.db, personId: p.id, context: { registration_id: a.registrationId }, locale: "fr-BE" })).toBeNull();
    // The consent the form recorded is crm's to erase (it stays until crm's step).
    expect(await h.db.select().from(consentRecords).where(eq(consentRecords.personId, p.id))).toHaveLength(1);
  });
});
