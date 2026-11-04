/**
 * credits-P5: the GDPR registration (credits spec section 9): export, erase (retained prepaid
 * grants, deleted goodwill grants and shares, redacted entries, retained memberships), the
 * retention sweeps and their agreement with the seeded `retention_policies` keys.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@beam/db";
import { bookings, creditEntries, creditGrants, creditReconciliationRuns, membershipPeriods, memberships, packageShares } from "@beam/db/schema";
import { createTestDb, makePerson, makeSession } from "@beam/db/testing";
import { makePaidOrder } from "@beam/db/testing/commerce-factories";
import { makeCreditGrant, makeEntry, makeMembership } from "@beam/db/testing/credits-factories";
import { CREDITS_RETENTION_POLICIES } from "@beam/db/seed/credits";
import { isValidRetentionSeed } from "@beam/core/privacy";
import { eq, inArray, or, sql, type Tx } from "@/lib/ctx";
import { resetRuntime } from "@/lib/testing";
import { GDPR_REGISTRY, NO_PII_TABLES } from "@/registry/privacy.generated";
import { noPiiTables, privacy, retention, sweep } from "./privacy";

let h: DbHandle;
beforeAll(async () => {
  h = await createTestDb();
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});

const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY);
const inTx = <T>(fn: (tx: Tx) => Promise<T>) => h.db.transaction((tx) => fn(tx as Tx));
const asRows = (v: unknown) => v as Record<string, unknown>[];

async function bookingFor(personId: string) {
  const session = await makeSession(h.db, { title: { "nl-BE": "Ochtendsauna", "fr-BE": "Sauna du matin", en: "Morning sauna" } });
  const [b] = await h.db.insert(bookings).values({ sessionId: session.id, personId, status: "confirmed", paidWith: "credit", source: "portal" }).returning();
  return b!;
}

async function purchaseGrant(personId: string, units = 10) {
  const { lines } = await makePaidOrder(h.db, { personId, lines: [{ productKind: "package" }] });
  return makeCreditGrant(h.db, {
    personId,
    source: "purchase",
    orderLineId: lines[0]!.id,
    lineUnitIndex: 1,
    productId: lines[0]!.productId,
    units,
    unitValueCents: 2_000,
    vatRatePct: "21.00",
    startsAt: ago(30),
    note: "Paid at the desk, customer asked about parking",
    label: { "nl-BE": "Pakket", "fr-BE": "Forfait", en: "Package" },
  });
}

describe("registration", () => {
  it("lists the V1 person tables and the NO_PII tables, and is in the generated registry", () => {
    expect([...privacy.tables].sort()).toEqual(["credit_entries", "credit_grants", "membership_periods", "memberships", "package_shares"]);
    expect(noPiiTables.filter((t) => privacy.tables.includes(t))).toEqual([]);
    expect(GDPR_REGISTRY.credits).toBe(privacy);
    for (const t of noPiiTables) expect(NO_PII_TABLES).toContain(t);
  });

  it("has one sweep handler per seeded retention key, and the same retention rows as the seed", () => {
    const keys = CREDITS_RETENTION_POLICIES.map((p) => p.key).sort();
    expect(Object.keys(sweep).sort()).toEqual(keys);
    expect(Object.keys(privacy.sweep ?? {}).sort()).toEqual(keys);
    expect(retention.map((r) => r.key).sort()).toEqual(keys);
    for (const r of retention) expect(isValidRetentionSeed(r)).toBe(true);
  });
});

describe("export", () => {
  it("contains owned grants with entries, beneficiary uses on other grants and memberships with periods", async () => {
    const owner = await makePerson(h.db, { firstName: "Olivia", lastName: "Owner" });
    const guest = await makePerson(h.db, { firstName: "Gina", lastName: "Guest" });
    const other = await makePerson(h.db, { firstName: "Otto", lastName: "Other" });
    const g = await purchaseGrant(owner.id, 10);
    const ownBooking = await bookingFor(owner.id);
    const guestBooking = await bookingFor(guest.id);
    await makeEntry(h.db, { grantId: g.id, kind: "consume", refType: "booking", refId: ownBooking.id, beneficiaryPersonId: owner.id });
    await makeEntry(h.db, { grantId: g.id, kind: "consume", refType: "booking", refId: guestBooking.id, beneficiaryPersonId: guest.id });
    await makeEntry(h.db, { grantId: g.id, kind: "adjust", quantity: -1, reason: "Goodwill correction", actor: { kind: "staff", id: crypto.randomUUID() } });
    const othersGrant = await makeCreditGrant(h.db, { personId: other.id, source: "import", vatTreatment: "single_purpose" });
    const usedBooking = await bookingFor(owner.id);
    await makeEntry(h.db, { grantId: othersGrant.id, kind: "consume", refType: "booking", refId: usedBooking.id, beneficiaryPersonId: owner.id });
    const m = await makeMembership(h.db, { personId: owner.id, notes: "Prefers mornings" });
    await h.db.insert(membershipPeriods).values({ membershipId: m.id, personId: owner.id, periodStartAt: m.currentPeriodStartAt, periodEndAt: m.currentPeriodEndAt, source: "purchase", amountCents: 4_900 });

    const out = await inTx((tx) => privacy.export(tx, owner.id));
    const grants = asRows(out.grants);
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({ id: g.id, source: "purchase", credit_kind: "day", units_granted: 10, remaining_units: 7, used_units: 2, status: "active", note: g.note });
    const entries = asRows(out.entries);
    expect(entries.map((e) => e.kind).sort()).toEqual(["adjust", "consume", "consume", "grant"]);
    expect(entries.find((e) => e.guest === "Gina G.")).toMatchObject({ kind: "consume", quantity: -1, session_title: { en: "Morning sauna" } });
    expect(entries.find((e) => e.kind === "adjust")).toMatchObject({ reason: "Goodwill correction", by: "BEAM staff" });
    expect(asRows(out.usesOnOtherGrants)).toEqual([expect.objectContaining({ kind: "consume", quantity: -1, owner: "Otto O.", credit_kind: "day" })]);
    const ms = asRows(out.memberships);
    expect(ms).toHaveLength(1);
    expect(ms[0]).toMatchObject({ id: m.id, status: "active", notes: "Prefers mornings" });
    expect(ms[0]!.periods).toEqual([expect.objectContaining({ source: "purchase", amount_cents: 4_900 })]);
    expect(JSON.stringify(out)).not.toContain(guest.lastName!);

    const guestOut = await inTx((tx) => privacy.export(tx, guest.id));
    expect(asRows(guestOut.grants)).toEqual([]);
    expect(asRows(guestOut.usesOnOtherGrants)).toEqual([expect.objectContaining({ owner: "Olivia O.", session_title: expect.objectContaining({ en: "Morning sauna" }) })]);
  });
});

describe("erase", () => {
  it("revokes and retains prepaid grants, deletes goodwill grants and shares, redacts entries, retains memberships", async () => {
    const p = await makePerson(h.db);
    const friend = await makePerson(h.db);
    const purchase = await purchaseGrant(p.id, 10);
    await makeEntry(h.db, { grantId: purchase.id, kind: "adjust", quantity: -2, reason: "Customer said knee injury" });
    await makeEntry(h.db, { grantId: purchase.id, kind: "extend", data: { old_expires_at: null, new_expires_at: ago(-400).toISOString(), reason: "holiday" } });
    const { lines: voucherLines } = await makePaidOrder(h.db, { personId: friend.id, lines: [{ productKind: "voucher" }] });
    const voucher = await makeCreditGrant(h.db, { personId: p.id, source: "voucher", creditKind: "euro", units: 5_000, unitValueCents: 1, orderLineId: voucherLines[0]!.id, startsAt: ago(5) });
    const refundRestore = await makeCreditGrant(h.db, { personId: p.id, source: "manual", creditKind: "euro", units: 1_200, unitValueCents: 1, vatTreatment: "multi_purpose", data: { refund_id: crypto.randomUUID() }, startsAt: ago(5) });
    const bonus = await makeCreditGrant(h.db, { personId: p.id, source: "bonus", units: 1, startsAt: ago(5) });
    const manualDay = await makeCreditGrant(h.db, { personId: p.id, source: "manual", units: 2, startsAt: ago(5), note: "Sorry gift" });
    const bonusBooking = await bookingFor(p.id);
    await makeEntry(h.db, { grantId: bonus.id, kind: "consume", refType: "booking", refId: bonusBooking.id, beneficiaryPersonId: p.id });
    const exhausted = await makeCreditGrant(h.db, { personId: p.id, source: "import", vatTreatment: "single_purpose", units: 1, status: "exhausted", startsAt: ago(5) });
    await makeEntry(h.db, { grantId: exhausted.id, kind: "consume", quantity: -1 });
    const m = await makeMembership(h.db, { personId: p.id, notes: "Asked to call after 18:00" });
    await h.db.insert(membershipPeriods).values({ membershipId: m.id, personId: p.id, periodStartAt: m.currentPeriodStartAt, periodEndAt: m.currentPeriodEndAt, source: "purchase" });
    const inclusion = await makeCreditGrant(h.db, { personId: p.id, source: "membership", membershipId: m.id, units: 4, startsAt: m.currentPeriodStartAt, expiresAt: m.currentPeriodEndAt });
    // Shares: given on the purchase grant, received on the friend's grant (with its cache).
    await h.db.insert(packageShares).values({ grantId: purchase.id, sharedWithPersonId: friend.id, createdByPersonId: p.id });
    const friendsGrant = await makeCreditGrant(h.db, {
      personId: friend.id,
      source: "import",
      vatTreatment: "single_purpose",
      units: 5,
      sharing: { mode: "named", max_guest_uses_per_month: 0, allowed_person_ids: [p.id] },
    });
    await h.db.insert(packageShares).values({ grantId: friendsGrant.id, sharedWithPersonId: p.id, createdByPersonId: friend.id });
    const guestBooking = await bookingFor(p.id);
    const guestUse = await makeEntry(h.db, { grantId: friendsGrant.id, kind: "consume", refType: "booking", refId: guestBooking.id, beneficiaryPersonId: p.id });

    const report = await inTx((tx) => privacy.erase(tx, p.id));
    expect(report).toEqual(
      expect.arrayContaining([
        { table: "credit_grants", rows: 5, action: "retained_legal" },
        { table: "credit_grants", rows: 2, action: "deleted" },
        { table: "credit_entries", rows: 3, action: "deleted" },
        { table: "credit_entries", rows: 1, action: "kept" },
        { table: "package_shares", rows: 2, action: "deleted" },
        { table: "memberships", rows: 1, action: "retained_legal" },
        { table: "membership_periods", rows: 1, action: "retained_legal" },
      ]),
    );

    const retainedIds = [purchase.id, voucher.id, refundRestore.id, exhausted.id, inclusion.id];
    const grants = await h.db.select().from(creditGrants).where(eq(creditGrants.personId, p.id));
    expect(grants.map((g) => g.id).sort()).toEqual([...retainedIds].sort());
    for (const g of grants) {
      expect(g.status).toBe("revoked");
      expect(g.note).toBeNull();
      expect(g.label).toBeNull();
    }
    expect(await h.db.select().from(creditGrants).where(inArray(creditGrants.id, [bonus.id, manualDay.id]))).toEqual([]);
    expect(await h.db.select().from(creditEntries).where(inArray(creditEntries.grantId, [bonus.id, manualDay.id]))).toEqual([]);

    const balances = await h.db.execute(sql`select grant_id, remaining_units from v_credit_grant_balances where grant_id = any(${`{${retainedIds.join(",")}}`}::uuid[])`);
    for (const b of (balances as unknown as { rows: { remaining_units: number }[] }).rows) expect(Number(b.remaining_units)).toBe(0);
    const revokes = await h.db.select().from(creditEntries).where(revokesOn(retainedIds));
    expect(revokes.map((r) => [r.grantId, r.quantity, r.reason, r.idempotencyKey]).sort()).toEqual(
      [
        [purchase.id, -8, "erased", `revoke:erase:${purchase.id}`],
        [voucher.id, -5_000, "erased", `revoke:erase:${voucher.id}`],
        [refundRestore.id, -1_200, "erased", `revoke:erase:${refundRestore.id}`],
        [inclusion.id, -4, "erased", `revoke:erase:${inclusion.id}`],
      ].sort(),
    );
    const purchaseEntries = await h.db.select().from(creditEntries).where(eq(creditEntries.grantId, purchase.id));
    expect(purchaseEntries.find((e) => e.kind === "adjust")!.reason).toBe("redacted");
    expect(purchaseEntries.find((e) => e.kind === "extend")!.data).toEqual({ old_expires_at: null, new_expires_at: expect.any(String) });

    expect(await h.db.select().from(packageShares).where(or(eq(packageShares.sharedWithPersonId, p.id), eq(packageShares.createdByPersonId, p.id)))).toEqual([]);
    const [friendsAfter] = await h.db.select().from(creditGrants).where(eq(creditGrants.id, friendsGrant.id));
    expect(friendsAfter!.sharing.allowed_person_ids).toEqual([]);
    expect(friendsAfter!.status).toBe("active");
    const [guestUseAfter] = await h.db.select().from(creditEntries).where(eq(creditEntries.id, guestUse.id));
    expect(guestUseAfter).toEqual(guestUse);

    const [mAfter] = await h.db.select().from(memberships).where(eq(memberships.id, m.id));
    expect(mAfter).toMatchObject({ status: "expired", endReason: "erased", notes: null });
    expect(mAfter!.endedAt).not.toBeNull();
    expect(await h.db.select().from(membershipPeriods).where(eq(membershipPeriods.membershipId, m.id))).toHaveLength(1);

    // No row outside the retained set references the person.
    const entryRefs = await h.db.select().from(creditEntries).where(or(eq(creditEntries.personId, p.id), eq(creditEntries.beneficiaryPersonId, p.id)));
    for (const e of entryRefs) expect([...retainedIds, friendsGrant.id]).toContain(e.grantId);
    const cache = await h.db.execute(sql`select id from credit_grants where sharing->'allowed_person_ids' ? ${p.id}`);
    expect((cache as unknown as { rows: unknown[] }).rows).toEqual([]);
    const textRefs = await h.db.execute(sql`select id from credit_entries where reason ilike '%knee%' or data::text ilike '%holiday%'`);
    expect((textRefs as unknown as { rows: unknown[] }).rows).toEqual([]);

    // A second erase changes nothing.
    const entriesBefore = await h.db.select().from(creditEntries).where(inArray(creditEntries.grantId, retainedIds));
    await inTx((tx) => privacy.erase(tx, p.id));
    expect(await h.db.select().from(creditEntries).where(inArray(creditEntries.grantId, retainedIds))).toHaveLength(entriesBefore.length);
  });
});

/** The `revoke` entries on `grantIds`. */
function revokesOn(grantIds: string[]) {
  return sql`${creditEntries.kind} = 'revoke' and ${creditEntries.grantId} = any(${`{${grantIds.join(",")}}`}::uuid[])`;
}

describe("sweep", () => {
  const cutoff = (days: number) => new Date(Date.now() - days * DAY);

  it("credits.ledger deletes closed grants past 3653 days with their entries and leaves a 3652-day-old one", async () => {
    const old = await makeCreditGrant(h.db, { source: "import", vatTreatment: "single_purpose", status: "expired", startsAt: ago(4_000), expiresAt: ago(3_660), statusChangedAt: ago(3_654) });
    const young = await makeCreditGrant(h.db, { source: "import", vatTreatment: "single_purpose", status: "expired", startsAt: ago(4_000), expiresAt: ago(3_655), statusChangedAt: ago(3_652) });
    const active = await makeCreditGrant(h.db, { source: "import", vatTreatment: "single_purpose", startsAt: ago(4_000), expiresAt: null, statusChangedAt: ago(3_700) });
    const n = await inTx((tx) => sweep["credits.ledger"]!(tx, cutoff(3_653)));
    expect(n).toBeGreaterThanOrEqual(1);
    const left = await h.db.select({ id: creditGrants.id }).from(creditGrants).where(inArray(creditGrants.id, [old.id, young.id, active.id]));
    expect(left.map((g) => g.id).sort()).toEqual([young.id, active.id].sort());
    expect(await h.db.select().from(creditEntries).where(eq(creditEntries.grantId, old.id))).toEqual([]);
    // A younger cutoff never reaches below the accounting horizon.
    await inTx((tx) => sweep["credits.ledger"]!(tx, cutoff(30)));
    expect(await h.db.select({ id: creditGrants.id }).from(creditGrants).where(eq(creditGrants.id, young.id))).toHaveLength(1);
  });

  it("credits.memberships deletes ended memberships past 3653 days with their periods and leaves a 3652-day-old one", async () => {
    const mk = async (endedDays: number) => {
      const m = await makeMembership(h.db, { status: "expired", startedAt: ago(endedDays + 30), currentPeriodEndAt: ago(endedDays), endedAt: ago(endedDays) });
      await h.db.insert(membershipPeriods).values({ membershipId: m.id, personId: m.personId, periodStartAt: m.currentPeriodStartAt, periodEndAt: m.currentPeriodEndAt, source: "purchase" });
      return m;
    };
    const old = await mk(3_654);
    const young = await mk(3_652);
    const n = await inTx((tx) => sweep["credits.memberships"]!(tx, cutoff(3_653)));
    expect(n).toBeGreaterThanOrEqual(1);
    const left = await h.db.select({ id: memberships.id }).from(memberships).where(inArray(memberships.id, [old.id, young.id]));
    expect(left.map((m) => m.id)).toEqual([young.id]);
    expect(await h.db.select().from(membershipPeriods).where(eq(membershipPeriods.membershipId, old.id))).toEqual([]);
    expect(await h.db.select().from(membershipPeriods).where(eq(membershipPeriods.membershipId, young.id))).toHaveLength(1);
  });

  it("credits.reconciliation_runs deletes runs older than the cutoff; credits.sharing_reviews has nothing before R2", async () => {
    const [oldRun] = await h.db.insert(creditReconciliationRuns).values({ startedAt: ago(366), finishedAt: ago(366), status: "ok" }).returning();
    const [newRun] = await h.db.insert(creditReconciliationRuns).values({ startedAt: ago(300), finishedAt: ago(300), status: "ok" }).returning();
    expect(await inTx((tx) => sweep["credits.reconciliation_runs"]!(tx, cutoff(365)))).toBe(1);
    const left = await h.db.select({ id: creditReconciliationRuns.id }).from(creditReconciliationRuns).where(inArray(creditReconciliationRuns.id, [oldRun!.id, newRun!.id]));
    expect(left.map((r) => r.id)).toEqual([newRun!.id]);
    expect(await inTx((tx) => sweep["credits.sharing_reviews"]!(tx, cutoff(730)))).toBe(0);
  });
});
