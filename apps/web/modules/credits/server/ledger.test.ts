import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle, Tx } from "@beam/db";
import { activityEvents, auditLog, creditEntries, creditGrants, orderLines, orders } from "@beam/db/schema";
import { makePerson, makeProduct, makeUser } from "@beam/db/testing";
import { makeCreditGrant } from "@beam/db/testing/credits-factories";
import { createTestDb } from "@beam/db/testing";
import { asc, createCtx, eq, type Actor, type Ctx } from "@/lib/ctx";
import { makeCtx, resetRuntime, staffActor } from "@/lib/testing";
import {
  adjust,
  balanceOf,
  consumeCredits,
  expireGrant,
  extend,
  InsufficientCreditsError,
  releaseCredits,
  revoke,
  revokeGrantRemainder,
  SharingNotAllowedError,
  transfer,
  type GrantRow,
} from "./ledger";

let h: DbHandle;
let staff: Actor;
beforeAll(async () => {
  h = await createTestDb();
  staff = staffActor({ userId: (await makeUser(h.db)).id, permissions: ["credits.adjust"] });
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});

const NOW = new Date();
const DAY = 86_400_000;
const at = (days: number) => new Date(NOW.getTime() + days * DAY);
const ctxAt = (now = NOW, actor?: Actor) => makeCtx(h.db, { now, ...(actor ? { actor } : {}) });

/** Runs `fn` in a real transaction with its own context (the way booking and commerce call the ledger). */
function inTx<T>(fn: (tx: Tx, ctx: Ctx) => Promise<T>, now = NOW): Promise<T> {
  return h.db.transaction(async (raw) => {
    const tx = raw;
    return fn(tx, createCtx({ tx, actor: { kind: "system", jobId: "" }, now, durableMode: "immediate" }));
  });
}

async function grant(over: Parameters<typeof makeCreditGrant>[1] = {}): Promise<GrantRow> {
  return makeCreditGrant(h.db, { startsAt: at(-30), expiresAt: at(60), source: "import", vatTreatment: "single_purpose", ...over });
}
const statusOf = async (id: string) => (await h.db.select({ s: creditGrants.status }).from(creditGrants).where(eq(creditGrants.id, id)))[0]!.s;
const entriesOf = (id: string) =>
  h.db.select().from(creditEntries).where(eq(creditEntries.grantId, id)).orderBy(asc(creditEntries.createdAt), asc(creditEntries.idempotencyKey));
const eventsOf = (id: string) =>
  h.db
    .select({ kind: activityEvents.kind, personId: activityEvents.personId, data: activityEvents.data, dedupeKey: activityEvents.dedupeKey })
    .from(activityEvents)
    .where(eq(activityEvents.refId, id))
    .orderBy(asc(activityEvents.id));
const consume = (g: GrantRow, units: number, over: Partial<Parameters<typeof consumeCredits>[2]> = {}, ctx = ctxAt()) =>
  consumeCredits(h.db, ctx, { personId: g.personId, beneficiaryPersonId: g.personId, kind: g.creditKind, units, ref: { type: "booking", id: randomUUID() }, ...over });

describe("locks and concurrency", () => {
  it("two transactions consume the last unit: the second fails with InsufficientCreditsError", async () => {
    const g = await grant({ units: 1 });
    const run = () => inTx((tx, ctx) => consumeCredits(tx, ctx, { personId: g.personId, beneficiaryPersonId: g.personId, kind: "day", units: 1, ref: { type: "booking", id: randomUUID() } }));
    const results = await Promise.allSettled([run(), run()]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const failed = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(failed.reason).toBeInstanceOf(InsufficientCreditsError);
    expect(failed.reason).toMatchObject({ code: "conflict", reason: "insufficient", needed: 1, available: 0 });
    expect(await balanceOf(h.db, g.id)).toBe(0);
    expect(await statusOf(g.id)).toBe("exhausted");
  });

  it("two parallel guest bookings for the last guest use: the second gets SharingNotAllowedError guest_limit", async () => {
    const g = await grant({ units: 10, sharing: { mode: "guests", max_guest_uses_per_month: 1, allowed_person_ids: [] } });
    const guests = [(await makePerson(h.db)).id, (await makePerson(h.db)).id];
    const run = (guest: string) =>
      inTx((tx, ctx) => consumeCredits(tx, ctx, { personId: g.personId, beneficiaryPersonId: guest, kind: "day", units: 1, ref: { type: "booking", id: randomUUID() } }));
    const results = await Promise.allSettled(guests.map(run));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const failed = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(failed.reason).toBeInstanceOf(SharingNotAllowedError);
    expect(failed.reason).toMatchObject({ code: "conflict", reason: "guest_limit" });
    expect(await balanceOf(h.db, g.id)).toBe(9);
  });

  it("a guest on a grant without sharing is not_shareable; the owner still books", async () => {
    const g = await grant({ units: 3 });
    const guest = (await makePerson(h.db)).id;
    await expect(consume(g, 1, { beneficiaryPersonId: guest })).rejects.toMatchObject({ name: "SharingNotAllowedError", reason: "not_shareable" });
    await expect(consume(g, 1)).resolves.toMatchObject({ remainingUnits: 2 });
  });

  it("a released guest use does not count towards the monthly guest limit; a limit of 0 forbids guests", async () => {
    const g = await grant({ units: 5, sharing: { mode: "guests", max_guest_uses_per_month: 1, allowed_person_ids: [] } });
    const guest = (await makePerson(h.db)).id;
    const ref = { type: "booking" as const, id: randomUUID() };
    await consume(g, 1, { beneficiaryPersonId: guest, ref });
    await expect(consume(g, 1, { beneficiaryPersonId: guest })).rejects.toMatchObject({ reason: "guest_limit" });
    await releaseCredits(h.db, ctxAt(), { ref, reason: "cancelled_in_policy" });
    await expect(consume(g, 1, { beneficiaryPersonId: guest })).resolves.toMatchObject({ remainingUnits: 4 });

    const zero = await grant({ units: 5, sharing: { mode: "guests", max_guest_uses_per_month: 0, allowed_person_ids: [] } });
    await expect(consume(zero, 1, { beneficiaryPersonId: guest })).rejects.toMatchObject({ reason: "not_shareable" });
  });
});

describe("idempotency", () => {
  it("consume and release twice change the balance once", async () => {
    const g = await grant({ units: 5 });
    const ref = { type: "booking" as const, id: randomUUID() };
    const first = await consume(g, 2, { ref });
    const second = await consume(g, 2, { ref });
    expect(second.entries).toEqual(first.entries);
    expect(first.entries[0]).toMatchObject({ grantId: g.id, quantity: -2 });
    expect(await balanceOf(h.db, g.id)).toBe(3);
    expect(await releaseCredits(h.db, ctxAt(), { ref, reason: "cancelled_in_policy" })).toEqual({ releasedUnits: 2 });
    expect(await releaseCredits(h.db, ctxAt(), { ref, reason: "cancelled_in_policy" })).toEqual({ releasedUnits: 0 });
    expect(await balanceOf(h.db, g.id)).toBe(5);
    const rel = (await entriesOf(g.id)).find((e) => e.kind === "release")!;
    expect(rel).toMatchObject({ quantity: 2, reversesEntryId: first.entries[0]!.entryId, idempotencyKey: `release:${first.entries[0]!.entryId}`, data: { reason: "cancelled_in_policy" } });
    await expect(consume(g, 1, { ref })).rejects.toMatchObject({ code: "conflict", message: "ref_already_released" });
  });

  it("a booking splits across grants, earliest expiry first, one consume per grant", async () => {
    const personId = (await makePerson(h.db)).id;
    const late = await grant({ personId, units: 5, expiresAt: at(90) });
    const soon = await grant({ personId, units: 1, expiresAt: at(10) });
    const ref = { type: "booking" as const, id: randomUUID() };
    const r = await consumeCredits(h.db, ctxAt(), { personId, beneficiaryPersonId: personId, kind: "day", units: 2, ref });
    expect(r.entries.map((e) => [e.grantId, e.quantity])).toEqual([
      [soon.id, -1],
      [late.id, -1],
    ]);
    expect(r.remainingUnits).toBe(4);
    const keys = (await h.db.select({ k: creditEntries.idempotencyKey }).from(creditEntries).where(eq(creditEntries.refId, ref.id))).map((x) => x.k).sort();
    expect(keys).toEqual([`consume:${ref.id}:${late.id}`, `consume:${ref.id}:${soon.id}`].sort());
  });

  it("a session after the grant's expiry cannot be paid by it (validAt)", async () => {
    const g = await grant({ units: 5, expiresAt: at(3) });
    await expect(consume(g, 1, { validAt: at(4) })).rejects.toMatchObject({ reason: "insufficient", available: 0 });
  });
});

describe("grant status machine (spec section 2)", () => {
  it("active -> exhausted by consume, negative adjust and transfer_out; exhausted -> active by release and positive adjust", async () => {
    const a = await grant({ units: 1 });
    const ref = { type: "booking" as const, id: randomUUID() };
    await consume(a, 1, { ref });
    expect(await statusOf(a.id)).toBe("exhausted");
    await releaseCredits(h.db, ctxAt(), { ref, reason: "session_cancelled" });
    expect(await statusOf(a.id)).toBe("active");

    const b = await grant({ units: 2 });
    await adjust(h.db, ctxAt(NOW, staff), { grantId: b.id, quantity: -2, reason: "duplicate import", clientKey: randomUUID() });
    expect(await statusOf(b.id)).toBe("exhausted");
    await adjust(h.db, ctxAt(NOW, staff), { grantId: b.id, quantity: 1, reason: "goodwill", clientKey: randomUUID() });
    expect(await statusOf(b.id)).toBe("active");

    const c = await grant({ units: 2 });
    await transfer(h.db, ctxAt(NOW, staff), { grantId: c.id, toPersonId: (await makePerson(h.db)).id, units: 2, reason: "family member", clientKey: randomUUID() });
    expect(await statusOf(c.id)).toBe("exhausted");
  });

  it("active -> expired by the expiry job, with an expire entry, or without one at balance 0", async () => {
    const g = await grant({ units: 4, expiresAt: at(1) });
    expect(await expireGrant(h.db, ctxAt(at(0.5)), g.id)).toEqual({ expired: false, units: 0 });
    expect(await expireGrant(h.db, ctxAt(at(2)), g.id)).toEqual({ expired: true, units: 4 });
    expect(await statusOf(g.id)).toBe("expired");
    expect((await entriesOf(g.id)).at(-1)).toMatchObject({ kind: "expire", quantity: -4 });
    expect(await expireGrant(h.db, ctxAt(at(2)), g.id)).toEqual({ expired: false, units: 0 });

    const drift = await grant({ units: 1, expiresAt: at(1) });
    await h.db.insert(creditEntries).values({ grantId: drift.id, personId: drift.personId, kind: "consume", quantity: -1, actor: { kind: "system", id: null }, idempotencyKey: `test:${randomUUID()}` });
    await expireGrant(h.db, ctxAt(at(2)), drift.id);
    expect(await statusOf(drift.id)).toBe("expired");
    expect((await entriesOf(drift.id)).map((e) => e.kind)).toEqual(["grant", "consume"]);
  });

  it("exhausted -> expired: a release after expires_at writes the release and an immediate expire (rule 26)", async () => {
    const g = await grant({ units: 1, expiresAt: at(1) });
    const ref = { type: "booking" as const, id: randomUUID() };
    await consume(g, 1, { ref });
    expect(await releaseCredits(h.db, ctxAt(at(2)), { ref, reason: "session_cancelled" })).toEqual({ releasedUnits: 1 });
    const es = await entriesOf(g.id);
    const rel = es.find((e) => e.kind === "release")!;
    expect(es.find((e) => e.kind === "expire")).toMatchObject({ quantity: -1, idempotencyKey: `expire:${g.id}:after_release:${rel.id}` });
    expect(await statusOf(g.id)).toBe("expired");
    expect(await balanceOf(h.db, g.id)).toBe(0);
  });

  it("expired -> active: extension within 365 days reinstates the expired units; later is refused", async () => {
    const g = await grant({ units: 3, expiresAt: at(1) });
    await expireGrant(h.db, ctxAt(at(2)), g.id);
    const r = await extend(h.db, ctxAt(at(100), staff), { grantId: g.id, newExpiresAt: at(200), reason: "closed for works", clientKey: randomUUID() });
    expect(r).toMatchObject({ created: true, reinstatedUnits: 3 });
    expect(await statusOf(g.id)).toBe("active");
    expect(await balanceOf(h.db, g.id)).toBe(3);
    const es = await entriesOf(g.id);
    expect(es.find((e) => e.kind === "extend")!.data).toMatchObject({ new_expires_at: at(200).toISOString() });
    expect(es.at(-1)).toMatchObject({ kind: "adjust", quantity: 3, reason: "reinstated on extension" });
    const [a] = await h.db.select().from(auditLog).where(eq(auditLog.entityId, g.id));
    expect(a).toMatchObject({ action: "credits.grant_extended" });

    const old = await grant({ units: 2, expiresAt: at(1) });
    await expireGrant(h.db, ctxAt(at(2)), old.id);
    await expect(extend(h.db, ctxAt(at(400), staff), { grantId: old.id, newExpiresAt: at(500), reason: "too late", clientKey: randomUUID() })).rejects.toMatchObject({ code: "conflict", message: "reinstate_window_passed" });
  });

  it("extend on active changes only expires_at; the new date must be later and within 5 years", async () => {
    const g = await grant({ units: 2, expiresAt: at(10) });
    await expect(extend(h.db, ctxAt(NOW, staff), { grantId: g.id, newExpiresAt: at(5), reason: "earlier", clientKey: randomUUID() })).rejects.toMatchObject({ code: "validation" });
    await expect(extend(h.db, ctxAt(NOW, staff), { grantId: g.id, newExpiresAt: at(6 * 366), reason: "far", clientKey: randomUUID() })).rejects.toMatchObject({ code: "validation" });
    const key = randomUUID();
    await extend(h.db, ctxAt(NOW, staff), { grantId: g.id, newExpiresAt: at(40), reason: "injury", clientKey: key });
    expect(await extend(h.db, ctxAt(NOW, staff), { grantId: g.id, newExpiresAt: at(40), reason: "injury", clientKey: key })).toMatchObject({ created: false });
    const [row] = await h.db.select().from(creditGrants).where(eq(creditGrants.id, g.id));
    expect(row).toMatchObject({ status: "active", expiresAt: at(40) });
    expect(await balanceOf(h.db, g.id)).toBe(2);
  });

  it("active -> revoked by staff revoke; extending a revoked grant is refused", async () => {
    const g = await grant({ units: 4 });
    await consume(g, 1);
    expect(await revoke(h.db, ctxAt(NOW, staff), { grantId: g.id, reason: "fraud", clientKey: randomUUID() })).toMatchObject({ revokedUnits: 3 });
    expect(await statusOf(g.id)).toBe("revoked");
    expect(await balanceOf(h.db, g.id)).toBe(0);
    await expect(extend(h.db, ctxAt(NOW, staff), { grantId: g.id, newExpiresAt: at(100), reason: "not allowed", clientKey: randomUUID() })).rejects.toMatchObject({ code: "conflict", message: "grant_revoked" });
    await expect(adjust(h.db, ctxAt(NOW, staff), { grantId: g.id, quantity: 1, reason: "not allowed", clientKey: randomUUID() })).rejects.toMatchObject({ code: "conflict" });
  });

  it("exhausted and expired grants are revoked only by erasure: staff revoke is refused", async () => {
    const g = await grant({ units: 1 });
    await consume(g, 1);
    await expect(revoke(h.db, ctxAt(NOW, staff), { grantId: g.id, reason: "fraud", clientKey: randomUUID() })).rejects.toMatchObject({ code: "conflict", message: "grant_exhausted" });
  });

  it("a negative balance is refused", async () => {
    const g = await grant({ units: 2 });
    await expect(adjust(h.db, ctxAt(NOW, staff), { grantId: g.id, quantity: -3, reason: "too much", clientKey: randomUUID() })).rejects.toBeInstanceOf(InsufficientCreditsError);
    await expect(consume(g, 3)).rejects.toMatchObject({ reason: "insufficient", available: 2 });
    expect(await balanceOf(h.db, g.id)).toBe(2);
  });
});

describe("thresholds and events (rules 19 to 23, cross-module D27)", () => {
  it("fires 50/75/80/90 %, last_unit and exhausted once each, with dedupe keys and the D27 shapes", async () => {
    const g = await grant({ units: 10 });
    await consume(g, 5);
    await consume(g, 3);
    const ref = { type: "booking" as const, id: randomUUID() };
    await consume(g, 1, { ref });
    // A release never un-fires; the re-booking does not re-fire.
    await releaseCredits(h.db, ctxAt(), { ref, reason: "rescheduled" });
    await consume(g, 1);
    await consume(g, 1);
    const ev = (await eventsOf(g.id)).filter((e) => e.kind === "credits.threshold_reached" || e.kind === "credits.grant_exhausted");
    expect(ev.map((e) => e.dedupeKey)).toEqual([
      `grant:${g.id}:threshold:50`,
      `grant:${g.id}:threshold:75`,
      `grant:${g.id}:threshold:80`,
      `grant:${g.id}:threshold:90`,
      `grant:${g.id}:threshold:last_unit`,
      `grant:${g.id}:exhausted`,
    ]);
    expect(ev[0]!.data).toEqual({ grant_id: g.id, credit_kind: "day", pct: 50, remaining_units: 5 });
    expect(ev[4]!.data).toEqual({ grant_id: g.id, credit_kind: "day", pct: "last_unit", remaining_units: 1 });
    expect(ev[5]!.data).toEqual({ grant_id: g.id, credit_kind: "day", source: "import", product_id: null });
    for (const e of ev) {
      expect(e.data).not.toHaveProperty("kind");
      expect(e.personId).toBe(g.personId);
    }
  });

  it("a 2-unit booking crosses 50 % and 75 % at once (edge case 15); imports use original_units as base", async () => {
    const g = await grant({ units: 4, creditKind: "night" });
    await consume(g, 2);
    await consume(g, 1);
    const pcts = (await eventsOf(g.id)).filter((e) => e.kind === "credits.threshold_reached").map((e) => (e.data as { pct: unknown }).pct);
    expect(pcts).toEqual([50, 75, "last_unit"]);

    const imp = await grant({ units: 4, data: { original_units: 10 } });
    await consume(imp, 2);
    const hits = (await eventsOf(imp.id)).filter((e) => e.kind === "credits.threshold_reached").map((e) => (e.data as { pct: unknown }).pct);
    expect(hits).toEqual([75, 80]);
  });

  it("bonus and membership grants fire no threshold events", async () => {
    const g = await grant({ units: 2, source: "bonus", vatTreatment: "not_applicable" });
    await consume(g, 2);
    expect((await eventsOf(g.id)).map((e) => e.kind)).toEqual(["credits.consumed"]);
  });

  it("guest use writes credits.consumed on the owner's and credits.guest_used on the guest's timeline", async () => {
    const g = await grant({ units: 5, sharing: { mode: "guests", max_guest_uses_per_month: 2, allowed_person_ids: [] } });
    const guest = (await makePerson(h.db)).id;
    const ref = { type: "booking" as const, id: randomUUID() };
    await consume(g, 1, { beneficiaryPersonId: guest, ref });
    const ev = await eventsOf(g.id);
    expect(ev.find((e) => e.kind === "credits.consumed")).toMatchObject({ personId: g.personId, data: { beneficiary_person_id: guest, credit_kind: "day", units: 1 } });
    expect(ev.find((e) => e.kind === "credits.guest_used")).toMatchObject({
      personId: guest,
      data: { grant_id: g.id, owner_person_id: g.personId, credit_kind: "day", ref_id: ref.id },
    });
    const [e] = await h.db.select().from(creditEntries).where(eq(creditEntries.refId, ref.id));
    expect(e).toMatchObject({ personId: g.personId, beneficiaryPersonId: guest });
  });
});

describe("euro, refunds and transfers", () => {
  it("euro consume and release for an order: earliest expiry first, vat_at_redemption, all given back", async () => {
    const personId = (await makePerson(h.db)).id;
    const euro = { creditKind: "euro" as const, source: "manual" as const, vatTreatment: "multi_purpose" as const, unitValueCents: 1, personId };
    const late = await grant({ ...euro, units: 5_000, expiresAt: at(300) });
    const soon = await grant({ ...euro, units: 1_000, expiresAt: at(20) });
    const order = { type: "order" as const, id: randomUUID() };
    const r = await consumeCredits(h.db, ctxAt(), { personId, beneficiaryPersonId: personId, kind: "euro", units: 2_500, ref: order });
    expect(r.entries.map((e) => [e.grantId, e.quantity])).toEqual([
      [soon.id, -1_000],
      [late.id, -1_500],
    ]);
    const rows = await h.db.select().from(creditEntries).where(eq(creditEntries.refId, order.id));
    expect(rows.map((x) => x.idempotencyKey).sort()).toEqual([`consume:order:${order.id}:${late.id}`, `consume:order:${order.id}:${soon.id}`].sort());
    for (const x of rows) expect(x.data).toEqual({ vat_at_redemption: true });
    await expect(consumeCredits(h.db, ctxAt(), { personId, beneficiaryPersonId: personId, kind: "euro", units: 1, ref: { type: "booking", id: randomUUID() } })).rejects.toMatchObject({ code: "validation" });
    expect(await releaseCredits(h.db, ctxAt(), { ref: order, reason: "order_expired" })).toEqual({ releasedUnits: 2_500 });
    expect(await balanceOf(h.db, soon.id)).toBe(1_000);
    expect(await statusOf(soon.id)).toBe("active");
  });

  it("transfer creates the recipient's grant with transfer_in and the source's transfer_out", async () => {
    const g = await grant({ units: 6, unitValueCents: 1_500 });
    const to = (await makePerson(h.db)).id;
    const clientKey = randomUUID();
    const r = await transfer(h.db, ctxAt(NOW, staff), { grantId: g.id, toPersonId: to, units: 2, reason: "gift to partner", clientKey });
    expect(await transfer(h.db, ctxAt(NOW, staff), { grantId: g.id, toPersonId: to, units: 2, reason: "gift to partner", clientKey })).toEqual({ toGrantId: r.toGrantId, created: false });
    const [t] = await h.db.select().from(creditGrants).where(eq(creditGrants.id, r.toGrantId));
    expect(t).toMatchObject({ personId: to, source: "transfer", creditKind: "day", unitsGranted: 2, unitValueCents: 1_500, vatTreatment: "single_purpose", expiresAt: g.expiresAt, data: { transfer_from_grant_id: g.id } });
    expect((await entriesOf(t!.id)).map((e) => [e.kind, e.quantity, e.idempotencyKey])).toEqual([["transfer_in", 2, `transfer:${clientKey}:in`]]);
    expect((await entriesOf(g.id)).at(-1)).toMatchObject({ kind: "transfer_out", quantity: -2, idempotencyKey: `transfer:${clientKey}:out` });
    expect(await balanceOf(h.db, g.id)).toBe(4);
    const audits = await h.db.select().from(auditLog).where(eq(auditLog.entityId, g.id));
    expect(audits.map((a) => a.action)).toEqual(["credits.transferred"]);
  });

  it("refund revocation revokes unused units only, and only the named grantIds", async () => {
    const personId = (await makePerson(h.db)).id;
    const line = await makePackageLine(personId, 3);
    const purchase = (i: number, expiresAt = at(60)) =>
      grant({ personId, units: 5, source: "purchase", orderLineId: line.id, lineUnitIndex: i, productId: line.productId, unitValueCents: 900, expiresAt });
    const [g1, g2, g3] = [await purchase(1, at(30)), await purchase(2, at(40)), await purchase(3, at(20))];
    await consume(g3, 5);
    await consume(g1, 2);
    const refundId = randomUUID();
    const named = await revokeGrantRemainder(h.db, ctxAt(), { orderLineId: line.id, grantIds: [g2.id], refundId, reason: "refund" });
    expect(named).toEqual({ revokedUnits: 5, grants: [{ grantId: g2.id, revokedUnits: 5 }] });
    expect(await statusOf(g1.id)).toBe("active");
    const rev = (await entriesOf(g2.id)).find((e) => e.kind === "revoke")!;
    expect(rev).toMatchObject({ quantity: -5, refType: "refund", refId: refundId, idempotencyKey: `revoke:order_line:${line.id}:${g2.id}` });

    const all = await revokeGrantRemainder(h.db, ctxAt(), { orderLineId: line.id, reason: "refund" });
    expect(all.revokedUnits).toBe(8); // g2 (already revoked by the first call) and g1
    expect(all.grants.find((x) => x.grantId === g1.id)).toEqual({ grantId: g1.id, revokedUnits: 3 });
    expect(await statusOf(g1.id)).toBe("revoked");
    expect(await statusOf(g3.id)).toBe("exhausted");
    expect(await balanceOf(h.db, g1.id)).toBe(0);
    // A replay changes nothing; a grant of another line is refused.
    expect((await revokeGrantRemainder(h.db, ctxAt(), { orderLineId: line.id, reason: "refund" })).revokedUnits).toBe(8);
    const other = await grant({ units: 1 });
    await expect(revokeGrantRemainder(h.db, ctxAt(), { orderLineId: line.id, grantIds: [other.id], reason: "refund" })).rejects.toMatchObject({ code: "validation" });
    // A release onto a refunded package is revoked again at once.
    const ref = { type: "booking" as const, id: randomUUID() };
    const g4 = await purchase(4, at(5));
    await consume(g4, 1, { ref });
    await revokeGrantRemainder(h.db, ctxAt(), { orderLineId: line.id, grantIds: [g4.id], reason: "refund" });
    await releaseCredits(h.db, ctxAt(), { ref, reason: "cancelled_in_policy" });
    expect(await balanceOf(h.db, g4.id)).toBe(0);
  });
});

/** A paid order with one package line of `quantity` packages. */
async function makePackageLine(personId: string, quantity: number) {
  const product = await makeProduct(h.db, { kind: "package", creditUnits: 5 });
  const [order] = await h.db
    .insert(orders)
    .values({ personId, channel: "admin", subtotalCents: 13_500, vatCents: 2_343, totalCents: 13_500, locale: "nl-BE", clientKey: randomUUID() })
    .returning();
  const [line] = await h.db
    .insert(orderLines)
    .values({
      orderId: order!.id,
      lineNo: 1,
      productId: product.id,
      productKind: "package",
      sku: product.sku,
      description: product.name,
      quantity,
      unitAmountCents: 4_500,
      lineTotalCents: 4_500 * quantity,
      vatRatePct: "21.00",
      vatCents: 781 * quantity,
      pricingTrace: {},
    })
    .returning();
  return line!;
}
