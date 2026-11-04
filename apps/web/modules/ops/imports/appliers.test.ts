import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle, Tx } from "@beam/db";
import { activityEvents, bookings, companies, companyContacts, consentRecords, creditGrants, importedHistory, importExternalIds, importRows, memberships, persons, personTags, suppressions, tags } from "@beam/db/schema";
import { createTestDb, makePerson, makeProduct, makeSession } from "@beam/db/testing";
import { emailHash } from "@beam/core/crm";
import type { ImportMapping } from "@beam/core/ops";
import type * as BookingApi from "@/modules/booking/api";
import type * as CreditsApi from "@/modules/credits/api";
import type * as CrmApi from "@/modules/crm/api";

vi.mock("@/modules/crm/api", async (orig) => {
  const m = await orig<typeof CrmApi>();
  return { ...m, updatePersonFields: vi.fn(m.updatePersonFields) };
});
// automation's stub throws until its package lands; crm's addSuppression calls it.
vi.mock("@/modules/automation/api", async (orig) => ({ ...(await orig<Record<string, unknown>>()), requestSuppressionExit: vi.fn().mockResolvedValue({ jobId: null }) }));
vi.mock("@/modules/credits/api", async (orig) => {
  const m = await orig<typeof CreditsApi>();
  return { ...m, importGrant: vi.fn(m.importGrant) };
});
vi.mock("@/modules/booking/api", async (orig) => {
  const m = await orig<typeof BookingApi>();
  return { ...m, importBooking: vi.fn(m.importBooking) };
});

const { and, eq } = await import("@/lib/ctx");
const { resetRuntime } = await import("@/lib/testing");
const { updatePersonFields } = await import("@/modules/crm/api");
const { importGrant } = await import("@/modules/credits/api");
const { importBooking } = await import("@/modules/booking/api");
const { applyRow } = await import("./apply");
const { APPLIERS } = await import("./jobs");
const { buildRunReport } = await import("./report");
const { baseOptions, jobCtx, row, seedImport, identityMapping } = await import("./ops-p4.fixtures");

let h: DbHandle;
const importIds: Record<string, string> = {};

beforeAll(async () => {
  h = await createTestDb();
  for (const kind of ["persons", "suppressions", "consents", "tags", "companies", "bookings", "packages", "memberships", "history"] as const) {
    importIds[kind] = await seedImport(h.db, { kind, csv: "email\n", mapping: identityMapping(["email"]), name: `Import ${kind}` });
  }
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(() => {
  vi.mocked(updatePersonFields).mockClear();
});

const mapping = (over: Partial<ImportMapping["options"]> = {}): ImportMapping => ({ columns: {}, options: baseOptions(over) });
type Kind = keyof typeof APPLIERS;
const apply = (kind: Kind, data: Record<string, string | null>, opts: { dryRun?: boolean; mapping?: ImportMapping; over?: Parameters<typeof row>[1]; now?: Date } = {}) =>
  applyRow(h.db as unknown as Tx, jobCtx(h.db, opts.now), row(data, { kind, importId: importIds[kind]!, importName: `Import ${kind}`, ...opts.over }), { dryRun: opts.dryRun ?? false, mapping: opts.mapping ?? mapping() }, APPLIERS[kind]);

async function personByEmail(email: string) {
  const [p] = await h.db.select().from(persons).where(eq(persons.email, email));
  return p;
}

async function erase(email: string) {
  await h.db.insert(suppressions).values({ emailHash: emailHash(email), scope: "all", reason: "erased", source: "privacy", actor: { kind: "system", id: null } });
}

describe("persons applier (rules 43, 45, 46, 47a, 50)", () => {
  it("R43 needs email or phone plus last name; an invalid address is an error", async () => {
    expect(await apply("persons", { first_name: "Ann" })).toEqual({ status: "error", message: "missing_email" });
    expect(await apply("persons", { email: "not-an-address" })).toEqual({ status: "error", message: "invalid_email" });
    expect(await apply("persons", { phone: "0470 99 88 77", last_name: "Claes", first_name: "Lies" })).toMatchObject({ status: "imported", message: "new" });
  });

  it("R46 a new person gets acquisition import with the import name and the row's locale", async () => {
    const out = await apply("persons", { email: "new-person@example.com", first_name: "Ann", locale: "fr" });
    expect(out).toMatchObject({ status: "imported", entityType: "person" });
    const p = await personByEmail("new-person@example.com");
    expect(p).toMatchObject({ id: out.personId, locale: "fr-BE", firstName: "Ann" });
    expect(p!.acquisition).toMatchObject({ source: "import", campaign: "Import persons" });
    const other = await apply("persons", { email: "default-locale@example.com" }, { mapping: mapping({ defaultLocale: "en" }) });
    expect((await personByEmail("default-locale@example.com"))!.locale).toBe("en");
    expect(other.status).toBe("imported");
  });

  it("R46 overwrite off keeps filled values; overwrite on replaces them; locale and acquisition never change", async () => {
    const p = await makePerson(h.db, { email: "keep@example.com", firstName: "Ann", phone: null, locale: "nl-BE", acquisition: { source: "website" } });
    const data = { email: "keep@example.com", first_name: "Anna", phone: "0470 11 22 33", locale: "en" };
    expect(await apply("persons", data)).toMatchObject({ status: "updated", message: "matched", personId: p.id });
    let now = await personByEmail("keep@example.com");
    expect(now).toMatchObject({ firstName: "Ann", phone: "0470 11 22 33", locale: "nl-BE" });
    expect(now!.acquisition).toMatchObject({ source: "website" });
    await apply("persons", data, { mapping: mapping({ overwrite: true }) });
    now = await personByEmail("keep@example.com");
    expect(now).toMatchObject({ firstName: "Anna", locale: "nl-BE" });
    expect(now!.acquisition).toMatchObject({ source: "website" });
  });

  it("R50 a simplybook row writes external_ids.simplybook through updatePersonFields; a Zoom row only import_external_ids", async () => {
    const sb = await apply("persons", { external_id: "SB-77", email: "sb77@example.com" }, { over: { source: "simplybook" } });
    expect(vi.mocked(updatePersonFields)).toHaveBeenCalledWith(expect.anything(), expect.anything(), sb.personId, { externalIds: { simplybook: "SB-77" } }, { onlyEmpty: true });
    expect((await personByEmail("sb77@example.com"))!.externalIds).toMatchObject({ simplybook: "SB-77" });
    expect(await h.db.select().from(importExternalIds).where(eq(importExternalIds.externalId, "SB-77"))).toMatchObject([{ source: "simplybook", entityType: "person", entityId: sb.personId }]);

    vi.mocked(updatePersonFields).mockClear();
    const zoom = await apply("persons", { external_id: "ZOOM-1", email: "zoom1@example.com" }, { over: { source: "webinar_tool" }, mapping: mapping({ preset: "zoom_registrants" }) });
    const externalCalls = vi.mocked(updatePersonFields).mock.calls.filter((c) => "externalIds" in (c[3] as object));
    expect(externalCalls).toEqual([]);
    expect((await personByEmail("zoom1@example.com"))!.externalIds).toEqual({});
    expect(await h.db.select().from(importExternalIds).where(eq(importExternalIds.externalId, "ZOOM-1"))).toMatchObject([{ source: "webinar_tool", entityId: zoom.personId }]);
  });

  it("R47a an erased address is skipped with erased and creates nobody", async () => {
    await erase("erased-p@example.com");
    expect(await apply("persons", { email: "Erased-P@example.com" })).toEqual({ status: "skipped", message: "erased" });
    expect(await personByEmail("erased-p@example.com")).toBeUndefined();
  });
});

describe("suppressions applier (rule 47)", () => {
  it("R47 imports through addSuppression once; the dry run writes nothing", async () => {
    expect(await apply("suppressions", { email: "dry-supp@example.com" }, { dryRun: true })).toMatchObject({ status: "imported" });
    expect(await h.db.select().from(suppressions).where(eq(suppressions.emailHash, emailHash("dry-supp@example.com")))).toEqual([]);
    expect(await apply("suppressions", { email: "unsub@example.com", scope: "newsletter" }, { over: { source: "mailchimp" } })).toMatchObject({ status: "imported", entityType: "suppression" });
    expect(await h.db.select().from(suppressions).where(eq(suppressions.emailHash, emailHash("unsub@example.com")))).toMatchObject([{ scope: "newsletter", reason: "unsubscribe", source: "import:mailchimp" }]);
    expect(await apply("suppressions", { email: "unsub@example.com", scope: "newsletter" }, { over: { source: "mailchimp" } })).toMatchObject({ status: "skipped", message: "existing" });
    expect(await apply("suppressions", { email: "cleaned@example.com" }, { mapping: mapping({ preset: "mailchimp_cleaned" }) })).toMatchObject({ status: "imported" });
    expect(await h.db.select({ reason: suppressions.reason, scope: suppressions.scope }).from(suppressions).where(eq(suppressions.emailHash, emailHash("cleaned@example.com")))).toEqual([{ reason: "hard_bounce", scope: "all" }]);
  });

  it("R47a an erased address is skipped", async () => {
    await erase("erased-s@example.com");
    expect(await apply("suppressions", { email: "erased-s@example.com" })).toEqual({ status: "skipped", message: "erased" });
  });
});

describe("consents applier (rule 47)", () => {
  it("R47 a granted consent for an address suppressed for all is skipped with suppressed, in dry runs too", async () => {
    const p = await makePerson(h.db, { email: "supp-c@example.com" });
    await h.db.insert(suppressions).values({ emailHash: emailHash("supp-c@example.com"), scope: "all", reason: "unsubscribe", source: "test", actor: { kind: "system", id: null } });
    const m = mapping({ consentPurpose: "newsletter" });
    expect(await apply("consents", { email: "supp-c@example.com", status: "subscribed" }, { dryRun: true, mapping: m })).toMatchObject({ status: "skipped", message: "suppressed" });
    expect(await apply("consents", { email: "supp-c@example.com", status: "subscribed" }, { mapping: m })).toMatchObject({ status: "skipped", message: "suppressed" });
    expect(await h.db.select().from(consentRecords).where(eq(consentRecords.personId, p.id))).toEqual([]);
  });

  it("R47 a consent import appends a record (method import) and leaves earlier consent_records untouched", async () => {
    const p = await makePerson(h.db, { email: "history-c@example.com" });
    const [earlier] = await h.db
      .insert(consentRecords)
      .values({ personId: p.id, purpose: "newsletter", status: "granted", method: "form", source: "form:intake", wordingVersion: "newsletter@1", recordedAt: new Date("2025-01-01T10:00:00Z"), actor: { kind: "system", id: null } })
      .returning();
    const out = await apply("consents", { email: "history-c@example.com", purpose: "newsletter", status: "unsubscribed", recorded_at: "2026-01-05T09:00:00Z" });
    expect(out).toMatchObject({ status: "imported", entityType: "consent", personId: p.id });
    const rows = await h.db.select().from(consentRecords).where(eq(consentRecords.personId, p.id)).orderBy(consentRecords.recordedAt);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual(earlier);
    expect(rows[1]).toMatchObject({ status: "withdrawn", method: "import", wordingVersion: "legacy-import", recordedAt: new Date("2026-01-05T09:00:00Z") });
  });

  it("R43 a consent row needs a status and a purpose", async () => {
    expect(await apply("consents", { email: "x-c@example.com", status: "maybe" }, { mapping: mapping({ consentPurpose: "events" }) })).toEqual({ status: "error", message: "invalid_status" });
    expect(await apply("consents", { email: "x-c@example.com", status: "granted" })).toEqual({ status: "error", message: "missing_purpose" });
  });
});

describe("tags applier", () => {
  it("R43 applies a known tag once; an unknown tag is an error", async () => {
    await h.db.insert(tags).values({ key: "imported_vip", name: { "nl-BE": "VIP", "fr-BE": "VIP", en: "VIP" } });
    expect(await apply("tags", { email: "tagged@example.com", tag_key: "nope_tag" })).toEqual({ status: "error", message: "unknown_tag" });
    const out = await apply("tags", { email: "tagged@example.com" }, { mapping: mapping({ tagKey: "imported_vip" }) });
    expect(out).toMatchObject({ status: "imported", entityType: "tag" });
    expect(await h.db.select().from(personTags).where(eq(personTags.personId, out.personId!))).toMatchObject([{ source: "import" }]);
    expect(await apply("tags", { email: "tagged@example.com", tag_key: "Imported_VIP" })).toMatchObject({ status: "skipped", message: "existing" });
  });
});

describe("companies applier", () => {
  it("R43 upserts the company and links the contact; a second row matches", async () => {
    const data = { name: "Acme Wellness BV", vat_number: "BE 0123.456.789", city: "Gent", contact_email: "buyer@example.com", contact_position: "HR", contact_decision_role: "decision_maker" };
    const out = await apply("companies", data);
    expect(out).toMatchObject({ status: "imported", entityType: "company" });
    expect(await h.db.select().from(companyContacts).where(eq(companyContacts.companyId, out.entityId!))).toMatchObject([{ position: "HR", decisionRole: "decision_maker" }]);
    expect(await apply("companies", data)).toMatchObject({ status: "updated", entityId: out.entityId });
    expect(await h.db.select({ n: companies.id }).from(companies).where(eq(companies.name, "Acme Wellness BV"))).toHaveLength(1);
    expect(await apply("companies", { city: "Gent" })).toEqual({ status: "error", message: "missing_name" });
  });
});

describe("bookings applier (rule 49)", () => {
  const future = new Date(Math.floor((Date.now() + 10 * 86_400_000) / 1000) * 1000);
  it("R49 each importBooking outcome maps to a row status; ops passes no status", async () => {
    const data = { email: "booker@example.com", session_starts_at: future.toISOString(), session_kind: "day", paid_with: "credit" };
    const cases = [
      ["created", { status: "imported" }],
      ["existing", { status: "skipped", message: "existing" }],
      ["no_session", { status: "error", message: "no_session" }],
      ["over_capacity", { status: "imported", message: "over_capacity" }],
    ] as const;
    for (const [outcome, expected] of cases) {
      vi.mocked(importBooking).mockResolvedValueOnce({ bookingId: outcome === "no_session" ? null : "00000000-0000-4000-8000-000000000001", outcome });
      expect(await apply("bookings", data, { over: { rowNumber: 7 } })).toMatchObject(expected);
    }
    const args = vi.mocked(importBooking).mock.calls.at(-1)![2];
    expect(args).toEqual({ externalRef: `import:${importIds.bookings}:row:7`, personId: expect.any(String), kind: "day", startsAt: future, paidWith: "credit" });
    expect(args).not.toHaveProperty("status");
  });

  it("R49 a real future booking is created on the materialised session; over capacity is listed in the report", async () => {
    const session = await makeSession(h.db, { startsAt: new Date(Date.UTC(2031, 0, 6, 9, 0)) });
    const out = await apply("bookings", { external_id: "SB-B-1", email: "real-booker@example.com", session_starts_at: "2031-01-06T09:00:00Z" });
    expect(out).toMatchObject({ status: "imported", entityType: "booking" });
    expect(await h.db.select().from(bookings).where(eq(bookings.id, out.entityId!))).toMatchObject([{ sessionId: session.id, status: "confirmed", externalRef: "SB-B-1" }]);
    expect(await apply("bookings", { email: "late@example.com", session_starts_at: "2020-01-01T09:00:00Z" })).toEqual({ status: "error", message: "past_booking" });

    await h.db.insert(importRows).values([
      { importId: importIds.bookings!, rowNumber: 1, data: {}, status: "imported", message: "over_capacity" },
      { importId: importIds.bookings!, rowNumber: 2, data: {}, status: "imported" },
    ]);
    expect((await buildRunReport(h.db, importIds.bookings!, "run")).over_capacity).toEqual([1]);
  });
});

describe("packages applier (rule 48)", () => {
  it("R48 importGrant gets idempotencyKey import:<import_id>:row:<n> without the grant: prefix; a re-run is skipped", async () => {
    await makeProduct(h.db, { kind: "package", sku: "PKG-TEN", creditKind: "day", creditUnits: 10 });
    const data = { email: "pkg@example.com", product_sku: "pkg-ten", units_remaining: "4", units_original: "10", expires_on: "2027-03-31" };
    const out = await apply("packages", data, { over: { rowNumber: 12 } });
    expect(out).toMatchObject({ status: "imported", entityType: "grant" });
    expect(vi.mocked(importGrant).mock.calls.at(-1)![2]).toMatchObject({ idempotencyKey: `import:${importIds.packages}:row:12`, units: 4, originalUnits: 10, creditKind: "day" });
    const [grant] = await h.db.select().from(creditGrants).where(eq(creditGrants.id, out.entityId!));
    expect(grant).toMatchObject({ source: "import", unitsGranted: 4 });
    expect(grant!.expiresAt!.toISOString()).toBe("2027-03-31T21:59:59.000Z");
    expect(await apply("packages", data, { over: { rowNumber: 12 } })).toMatchObject({ status: "skipped", message: "existing", entityId: out.entityId });
    expect(await apply("packages", { ...data, product_sku: "UNKNOWN-SKU" })).toEqual({ status: "error", message: "unknown_product" });
  });
});

describe("memberships applier (rule 49)", () => {
  it("R49 imports an active membership with the file's period end and no mandate", async () => {
    await makeProduct(h.db, { kind: "membership", sku: "MEMB-MONTH" });
    const out = await apply("memberships", { email: "member@example.com", product_sku: "MEMB-MONTH", period_end_on: "2026-12-31" });
    expect(out).toMatchObject({ status: "imported", entityType: "membership" });
    const [m] = await h.db.select().from(memberships).where(eq(memberships.id, out.entityId!));
    expect(m).toMatchObject({ status: "active", source: "import", mandateId: null });
    expect(m!.currentPeriodEndAt.toISOString()).toBe("2026-12-31T22:59:59.000Z");
    expect(await apply("memberships", { email: "member@example.com", product_sku: "PKG-TEN", period_end_on: "2026-12-31" })).toEqual({ status: "error", message: "unknown_product" });
  });
});

describe("history applier (rules 47b, 50)", () => {
  it("R50 writes imported_history and one ops.history_imported event at the original occurred_at; a re-import adds nothing", async () => {
    const data = { email: "hist@example.com", history_kind: "visit", occurred_at: "2025-03-04T10:00:00Z", external_id: "SB-H-1" };
    const out = await apply("history", data, { over: { source: "simplybook" } });
    expect(out).toMatchObject({ status: "imported", entityType: "history" });
    expect(await h.db.select().from(importedHistory).where(eq(importedHistory.externalId, "SB-H-1"))).toMatchObject([{ kind: "visit", source: "simplybook", personId: out.personId }]);
    const events = await h.db.select().from(activityEvents).where(and(eq(activityEvents.personId, out.personId!), eq(activityEvents.kind, "ops.history_imported")));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ occurredAt: new Date("2025-03-04T10:00:00Z"), dedupeKey: "import:simplybook:visit:SB-H-1", data: { kind: "visit", source: "simplybook" } });
    expect(await apply("history", data, { over: { source: "simplybook" } })).toMatchObject({ status: "skipped", message: "existing" });
    expect(await h.db.select().from(activityEvents).where(eq(activityEvents.kind, "ops.history_imported"))).toHaveLength(1);
  });

  it("R50 a purchase keeps its amount; euros with a decimal comma become cents", async () => {
    const out = await apply("history", { email: "buyer-h@example.com", history_kind: "purchase", occurred_at: "2025-02-01", external_id: "LS-R-1", amount_cents: "45,50", product_kind: "Package" }, { over: { source: "lightspeed" } });
    expect(await h.db.select().from(importedHistory).where(eq(importedHistory.id, out.entityId!))).toMatchObject([{ amountCents: 4550, productKind: "package" }]);
    expect(await apply("history", { email: "buyer-h@example.com", history_kind: "nonsense", occurred_at: "2025-02-01", external_id: "X" })).toEqual({ status: "error", message: "invalid_history_kind" });
  });
});
