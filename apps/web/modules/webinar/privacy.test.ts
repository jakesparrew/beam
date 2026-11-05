/**
 * webinar privacy (spec section 9; webinar-P3 adds the registration cases, webinar-P1's cases are
 * in `webinar-p1.privacy.test.ts`, webinar-P6 completes this file): registrations made through
 * `registerPerson` are exported with the title in the registration's locale, status, source,
 * dates and UTM, never with the token hash; erasure deletes them, after which the personal link
 * no longer resolves and the merge fields return null (edge case 18). Consent records written at
 * registration belong to crm's erasure, not this module's.
 *
 * webinar-P6 completes the file (section 9): with a person merged into the subject who registered
 * for the same webinar, the export lists both registrations, the merged watch per mode (intervals
 * of both registrations merged, from `v_webinar_watch`) and the raw segments, the poll answers
 * with question and option labels in the registration's language, and the chat text; erasure
 * leaves no row referencing either person in the five tables, reports per-table counts, and a
 * second erase is a no-op; every sweep handler is keyed `webinar.*`, returns a number and
 * deletes only rows older than the cutoff through the append-only trigger.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle, Tx } from "@beam/db";
import { consentRecords, persons, watchSegments, webinarInteractions, webinarModerationActions, webinarPresenters, webinarRegistrations } from "@beam/db/schema";
import { createTestDb, makePerson, makeUser } from "@beam/db/testing";
import { NotFoundError, eq, inArray, or } from "@/lib/ctx";
import { makeCtx } from "@/lib/testing";
import { GDPR_REGISTRY } from "@/registry/privacy.generated";
import { getAccessUrl } from "./api";
import { mergeFields } from "./merge-fields";
import { privacy } from "./privacy";
import { cancelRegistration, registerPerson } from "./server/registration";
import { makeCta, makePoll, makeRegistration, makeSegments, makeWebinar, WEBINAR_TITLE } from "./test/factories";

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

describe("complete export and erase with a merged person (webinar-P6)", () => {
  it("exports both registrations, merged watch, raw segments, labelled poll answers and chat; erase leaves nothing in the five tables", async () => {
    const subject = await makePerson(h.db);
    const merged = await makePerson(h.db);
    const w = await makeWebinar(h.db, { ownerUserId: ownerId }, { published: true });
    const own = await makeRegistration(h.db, { webinarId: w.id, personId: subject.id, locale: "fr-BE" });
    // The merged person registered for the same webinar: the merge keeps that registration on the loser id.
    const kept = await makeRegistration(h.db, { webinarId: w.id, personId: merged.id, locale: "nl-BE" });
    await h.db.update(persons).set({ mergedIntoPersonId: subject.id }).where(eq(persons.id, merged.id));
    // Two tabs: [0, 30] on one registration and [15, 45] on the other merge to 45 s of live.
    await makeSegments(h.db, own, "live", [
      [0, 15],
      [15, 30],
    ]);
    await makeSegments(h.db, kept, "live", [
      [15, 30],
      [30, 45],
    ]);
    await makeSegments(h.db, own, "replay", [[0, 20]]);
    const poll = await makePoll(h.db, { webinarId: w.id });
    const cta = await makeCta(h.db, { webinarId: w.id });
    const [chat] = await h.db
      .insert(webinarInteractions)
      .values([
        { registrationId: own.id, webinarId: w.id, mode: "live", kind: "poll_answer", pollId: poll.id, payload: { option_keys: ["yes"] } },
        { registrationId: own.id, webinarId: w.id, mode: "replay", kind: "poll_answer", pollId: poll.id, payload: { option_keys: ["no"] } },
        { registrationId: kept.id, webinarId: w.id, mode: "live", kind: "chat", payload: { text: "Hallo iedereen" } },
        { registrationId: own.id, webinarId: w.id, mode: "live", kind: "cta_clicked", ctaId: cta.id, payload: { url: cta.url } },
      ])
      .returning();
    await h.db.insert(webinarModerationActions).values({ webinarId: w.id, registrationId: kept.id, interactionId: chat!.id, action: "hide_message", byUserId: ownerId });
    await h.db.insert(webinarPresenters).values({ webinarId: w.id, personId: merged.id, displayName: "Gastspreker" });

    const exported = await h.db.transaction((t) => privacy.export(t, subject.id));
    expect((exported["webinar/registrations.json"] as unknown[]).length).toBe(2);
    const watch = exported["webinar/watch.json"] as Array<Record<string, unknown>>;
    expect(watch.map((x) => [x.mode, x.watched_sec]).sort()).toEqual([
      ["live", 45],
      ["replay", 20],
    ]);
    expect(exported["webinar/watch_segments.json"]).toHaveLength(5);
    expect(String(exported["webinar/watch_segments.csv"]).split("\r\n")[0]).toBe("webinar_title,mode,from_sec,to_sec,recorded_at");
    const interactions = exported["webinar/interactions.json"] as Array<Record<string, unknown>>;
    expect(interactions.filter((i) => i.kind === "poll_answer").map((i) => [i.mode, i.poll_question, i.poll_answer]).sort()).toEqual([
      ["live", "Dormez-vous bien ?", ["Oui"]],
      ["replay", "Dormez-vous bien ?", ["Non"]],
    ]);
    expect(interactions.find((i) => i.kind === "chat")).toMatchObject({ text: "Hallo iedereen", mode: "live", webinar_title: WEBINAR_TITLE["nl-BE"] });
    expect(interactions.find((i) => i.kind === "cta_clicked")).toMatchObject({ cta_label: "Réservez une séance", cta_url: cta.url });
    expect(exported["webinar/moderation.json"]).toEqual([expect.objectContaining({ action: "hide_message" })]);
    expect(exported["webinar/presenters.json"]).toEqual([expect.objectContaining({ display_name: "Gastspreker" })]);
    expect(JSON.stringify(exported)).not.toContain(ownerId);

    const report = await h.db.transaction((t) => privacy.erase(t, subject.id));
    expect(Object.fromEntries(report.map((r) => [r.table, [r.rows, r.action]]))).toEqual({
      webinar_registrations: [2, "deleted"],
      watch_segments: [5, "deleted"],
      webinar_interactions: [4, "deleted"],
      webinar_moderation_actions: [1, "deleted"],
      webinar_presenters: [1, "deleted"],
    });
    const ids = [subject.id, merged.id];
    const regIds = [own.id, kept.id];
    expect(await h.db.select().from(webinarRegistrations).where(inArray(webinarRegistrations.personId, ids))).toEqual([]);
    expect(await h.db.select().from(watchSegments).where(inArray(watchSegments.registrationId, regIds))).toEqual([]);
    expect(await h.db.select().from(webinarInteractions).where(inArray(webinarInteractions.registrationId, regIds))).toEqual([]);
    expect(await h.db.select().from(webinarModerationActions).where(inArray(webinarModerationActions.registrationId, regIds))).toEqual([]);
    expect(await h.db.select().from(webinarPresenters).where(or(inArray(webinarPresenters.personId, ids)))).toEqual([]);
    // The other rows of the webinar (polls, CTAs) are not personal data and stay.
    expect(await h.db.select().from(webinarInteractions).where(eq(webinarInteractions.pollId, poll.id))).toEqual([]);

    const again = await h.db.transaction((t) => privacy.erase(t, subject.id));
    expect(again.map((r) => r.rows)).toEqual([0, 0, 0, 0, 0]);
    expect(await h.db.transaction((t) => privacy.export(t, subject.id))).toMatchObject({ "webinar/registrations.json": [], "webinar/interactions.json": [] });
  });

  it("every sweep key starts with webinar. and returns a number; nothing newer than the cutoff is deleted", async () => {
    const w = await makeWebinar(h.db, { ownerUserId: ownerId }, { published: true });
    const r = await makeRegistration(h.db, { webinarId: w.id });
    await makeSegments(h.db, r, "live", [[0, 15]]);
    await h.db.insert(webinarInteractions).values({ registrationId: r.id, webinarId: w.id, mode: "live", kind: "chat", payload: { text: "recent" } });
    const cutoff = new Date(Date.now() - 730 * 86_400_000);
    expect(Object.keys(privacy.sweep ?? {}).length).toBeGreaterThan(0);
    for (const [key, run] of Object.entries(privacy.sweep ?? {})) {
      expect(key.startsWith("webinar.")).toBe(true);
      const n = await h.db.transaction((t) => run(t, cutoff));
      expect(typeof n, key).toBe("number");
    }
    expect(await h.db.select().from(webinarRegistrations).where(eq(webinarRegistrations.id, r.id))).toHaveLength(1);
    expect(await h.db.select().from(watchSegments).where(eq(watchSegments.registrationId, r.id))).toHaveLength(1);
    expect(await h.db.select().from(webinarInteractions).where(eq(webinarInteractions.registrationId, r.id))).toHaveLength(1);
  });
});
