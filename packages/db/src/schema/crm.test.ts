/**
 * crm schema and views on PGlite (crm-P1): partial unique email, check constraints, the five
 * V1 views, append-only tables and the defaults seed.
 */
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SEGMENT_ALLOWED_EVENT_KINDS, SEGMENT_ALLOWED_FIELDS, emailHash } from "@beam/core/crm";
import type { DbHandle } from "../client";
import { seed as crmSeed } from "../seed/crm";
import { createTestDb, makePerson, makeUser } from "../testing";
import { SENSITIVE_COLUMNS } from "./_shared";
import {
  companies,
  companyContacts,
  consentRecords,
  consentWordings,
  personDeclarations,
  personDuplicateCandidates,
  personMerges,
  segments,
  suppressions,
  tags,
  tasks,
} from "./crm";
import * as schemaIndex from "./index";
import { STATUS_OVERRIDE_CONFLICTS_DEFINITION, vStatusOverrideConflictsSql } from "./crm.views";

const SYSTEM = { kind: "system", id: null } as const;

async function pgError(promise: Promise<unknown>): Promise<{ message: string; code?: string }> {
  try {
    await promise;
  } catch (error) {
    const cause = (error as { cause?: { message?: string; code?: string } }).cause ?? (error as { message?: string; code?: string });
    return { message: String(cause.message ?? error), code: cause.code };
  }
  throw new Error("expected the query to fail");
}

const rows = <T>(r: unknown) => (r as { rows: T[] }).rows;

let h: DbHandle;
beforeAll(async () => {
  h = await createTestDb();
});
afterAll(() => h.close());

describe("persons", () => {
  it("3.1 partial unique email: a merged or erased person may share an active person's address", async () => {
    const active = await makePerson(h.db, { email: "dup@example.com" });
    const dup = await pgError(makePerson(h.db, { email: "DUP@example.com".toLowerCase() }));
    expect(dup.message).toContain("persons_email_active_uq");
    const loser = await makePerson(h.db, { email: "dup2@example.com" });
    await h.db.execute(sql`update persons set email = 'dup@example.com', merged_into_person_id = ${active.id} where id = ${loser.id}`);
    const erased = await makePerson(h.db, { email: "dup3@example.com" });
    await h.db.execute(sql`update persons set email = 'dup@example.com', erased_at = now() where id = ${erased.id}`);
    const same = rows<{ n: number }>(await h.db.execute(sql`select count(*)::int as n from persons where lower(email) = 'dup@example.com'`));
    expect(same[0]!.n).toBe(3);
  });

  it("assigns customer numbers and keeps search_tsv in sync", async () => {
    const a = await makePerson(h.db, { firstName: "Lotte", lastName: "Peeters", email: "lotte.peeters@example.com", phoneE164: "+32470123456" });
    const b = await makePerson(h.db);
    expect(b.customerNumber).toBeGreaterThan(a.customerNumber);
    const hit = rows<{ id: string }>(await h.db.execute(sql`select id from persons where search_tsv @@ to_tsquery('simple', 'peet:*')`));
    expect(hit.map((r) => r.id)).toContain(a.id);
    const phone = rows<{ id: string }>(await h.db.execute(sql`select id from persons where search_tsv @@ plainto_tsquery('simple', '+32470123456')`));
    expect(phone.map((r) => r.id)).toContain(a.id);
  });

  it("enforces the person checks", async () => {
    expect((await pgError(makePerson(h.db, { email: "not-an-email" }))).message).toContain("persons_email_ck");
    expect((await pgError(makePerson(h.db, { phoneE164: "0470123456" }))).message).toContain("persons_phone_e164_ck");
    expect((await pgError(makePerson(h.db, { firstName: "x".repeat(101) }))).message).toContain("persons_name_length_ck");
    expect((await pgError(makePerson(h.db, { birthOn: "1899-12-31" }))).message).toContain("persons_birth_on_ck");
    expect((await pgError(makePerson(h.db, { statusOverride: "customer" }))).message).toContain("persons_status_override_reason_ck");
    const p = await makePerson(h.db);
    expect((await pgError(h.db.execute(sql`update persons set merged_into_person_id = id where id = ${p.id}`))).message).toContain("persons_merged_into_ck");
  });

  it("links a partner company and nulls it when the company is deleted", async () => {
    const [c] = await h.db.insert(companies).values({ name: "Partner BV", isPartner: true, partnerCommissionPct: "10.00" }).returning();
    const p = await makePerson(h.db, { partnerCompanyId: c!.id });
    await h.db.execute(sql`delete from companies where id = ${c!.id}`);
    const [row] = rows<{ partner_company_id: string | null }>(await h.db.execute(sql`select partner_company_id from persons where id = ${p.id}`));
    expect(row!.partner_company_id).toBeNull();
  });
});

describe("identity tables", () => {
  it("person_merges is append-only, one merge per loser, never a self merge", async () => {
    const user = await makeUser(h.db);
    const [w, l] = [await makePerson(h.db), await makePerson(h.db)];
    await h.db.insert(personMerges).values({ winnerPersonId: w.id, loserPersonId: l.id, loserSnapshot: {}, mergedByUserId: user.id });
    expect((await pgError(h.db.insert(personMerges).values({ winnerPersonId: w.id, loserPersonId: l.id, loserSnapshot: {}, mergedByUserId: user.id }))).message).toContain(
      "person_merges_loser_person_id_unique",
    );
    expect((await pgError(h.db.insert(personMerges).values({ winnerPersonId: w.id, loserPersonId: w.id, loserSnapshot: {}, mergedByUserId: user.id }))).message).toContain("person_merges_distinct_ck");
    expect((await pgError(h.db.execute(sql`update person_merges set repointed = '{}'::jsonb`))).message).toMatch(/append-only|append_only|not allowed/i);
  });

  it("duplicate candidates are ordered pairs with a score of 0..100 and known reasons", async () => {
    const [x, y] = [await makePerson(h.db), await makePerson(h.db)];
    const [a, b] = x.id < y.id ? [x.id, y.id] : [y.id, x.id];
    await h.db.insert(personDuplicateCandidates).values({ personAId: a, personBId: b, score: 90, reasons: ["email_variant"] });
    expect((await pgError(h.db.insert(personDuplicateCandidates).values({ personAId: b, personBId: a, score: 90, reasons: ["phone"] }))).message).toContain("person_duplicate_candidates_order_ck");
    const [z] = [await makePerson(h.db)];
    const [c, d] = a < z.id ? [a, z.id] : [z.id, a];
    expect((await pgError(h.db.insert(personDuplicateCandidates).values({ personAId: c, personBId: d, score: 101, reasons: ["phone"] }))).message).toContain("person_duplicate_candidates_score_ck");
    expect((await pgError(h.db.insert(personDuplicateCandidates).values({ personAId: c, personBId: d, score: 50, reasons: ["shoe_size"] }))).message).toContain("person_duplicate_candidates_reasons_ck");
  });

  it("3.54 guardian_consent needs a guardian person", async () => {
    const minor = await makePerson(h.db, { birthOn: "2015-05-01" });
    const err = await pgError(
      h.db.insert(personDeclarations).values({ personId: minor.id, kind: "guardian_consent", documentVersionId: crypto.randomUUID(), documentVersion: 1, method: "reception", actor: SYSTEM }),
    );
    expect(err.message).toContain("person_declarations_guardian_ck");
  });
});

describe("consent and suppression", () => {
  it("consent_records takes the ADD columns and stays append-only", async () => {
    const p = await makePerson(h.db);
    const [r] = await h.db
      .insert(consentRecords)
      .values({ personId: p.id, purpose: "b2b", status: "granted", lawfulBasis: "legitimate_interest", source: "staff:x", method: "staff", wordingVersion: "b2b@1", actor: SYSTEM, userAgent: "test", refType: "form_submission", refId: "1" })
      .returning();
    expect(r!.lawfulBasis).toBe("legitimate_interest");
    expect((await pgError(h.db.execute(sql`delete from consent_records where id = ${r!.id}`))).message).toMatch(/append-only|append_only|not allowed/i);
  });

  it("3.13 v_consent_current returns the latest row per person and purpose, ties by created_at then id", async () => {
    const p = await makePerson(h.db);
    const t = new Date("2026-05-01T10:00:00Z");
    const base = { personId: p.id, source: "form:x", method: "form" as const, wordingVersion: "newsletter@1", actor: SYSTEM };
    await h.db.insert(consentRecords).values({ ...base, purpose: "newsletter", status: "granted", recordedAt: new Date("2026-04-01T10:00:00Z") });
    await h.db.insert(consentRecords).values({ ...base, purpose: "newsletter", status: "withdrawn", wordingVersion: "unsubscribe", recordedAt: t, createdAt: new Date("2026-05-01T10:00:01Z") });
    await h.db.insert(consentRecords).values({ ...base, purpose: "newsletter", status: "granted", recordedAt: t, createdAt: new Date("2026-05-01T10:00:00Z") });
    await h.db.insert(consentRecords).values({ ...base, purpose: "events", status: "granted", wordingVersion: "events@1" });
    const current = rows<{ purpose: string; status: string; withdrawn_at: unknown; granted_at: unknown }>(
      await h.db.execute(sql`select purpose, status, granted_at, withdrawn_at from v_consent_current where person_id = ${p.id} order by purpose`),
    );
    expect(current.map((c) => [c.purpose, c.status])).toEqual([
      ["newsletter", "withdrawn"],
      ["events", "granted"],
    ]);
    expect(current[0]!.withdrawn_at).not.toBeNull();
    expect(current[0]!.granted_at).toBeNull();
  });

  it("3.19 v_suppression_status: a scoped unsubscribe is lifted only by a newer portal grant; all never lifts", async () => {
    const email = "lift@example.com";
    const p = await makePerson(h.db, { email, emailHash: emailHash(email) });
    const status = async () =>
      Object.fromEntries(
        rows<{ purpose: string; is_suppressed: boolean }>(await h.db.execute(sql`select purpose, is_suppressed from v_suppression_status where person_id = ${p.id}`)).map((r) => [
          r.purpose,
          r.is_suppressed,
        ]),
      );
    expect(await status()).toEqual({ newsletter: false, events: false, member_comms: false, b2b: false });
    await h.db.insert(suppressions).values({ emailHash: emailHash(email), email, scope: "newsletter", reason: "unsubscribe", source: "unsubscribe_link", personId: p.id, actor: SYSTEM, createdAt: new Date("2026-03-01T00:00:00Z") });
    expect((await status()).newsletter).toBe(true);
    const grant = { personId: p.id, purpose: "newsletter" as const, status: "granted" as const, wordingVersion: "newsletter@1", actor: SYSTEM };
    await h.db.insert(consentRecords).values({ ...grant, method: "import", source: "import:1", recordedAt: new Date("2026-04-01T00:00:00Z") });
    expect((await status()).newsletter).toBe(true);
    await h.db.insert(consentRecords).values({ ...grant, method: "portal", source: "portal", recordedAt: new Date("2026-05-01T00:00:00Z") });
    expect((await status()).newsletter).toBe(false);
    await h.db.insert(suppressions).values({ emailHash: emailHash(email), email, scope: "all", reason: "hard_bounce", source: "resend", actor: SYSTEM });
    expect(await status()).toEqual({ newsletter: true, events: true, member_comms: true, b2b: true });
    expect((await pgError(h.db.insert(suppressions).values({ emailHash: emailHash(email), scope: "all", reason: "complaint", source: "x", actor: SYSTEM }))).message).toContain(
      "suppressions_email_hash_scope_uq",
    );
  });

  it("3.22 persons without email, erased or restricted are suppressed; merged persons have no rows", async () => {
    const noEmail = await makePerson(h.db, { email: null });
    const restricted = await makePerson(h.db, { processingRestrictedAt: new Date() });
    const winner = await makePerson(h.db);
    const merged = await makePerson(h.db, { mergedIntoPersonId: winner.id });
    const r = rows<{ person_id: string; is_suppressed: boolean }>(
      await h.db.execute(sql`select person_id, is_suppressed from v_suppression_status where person_id in (${noEmail.id}, ${restricted.id}, ${merged.id})`),
    );
    expect(r.filter((x) => x.person_id === noEmail.id).every((x) => x.is_suppressed)).toBe(true);
    expect(r.filter((x) => x.person_id === restricted.id).every((x) => x.is_suppressed)).toBe(true);
    expect(r.filter((x) => x.person_id === merged.id)).toEqual([]);
  });

  it("consent_wordings are unique per purpose and version", async () => {
    await h.db.insert(consentWordings).values({ purpose: "events", version: 7, text: { en: "a", "nl-BE": "b", "fr-BE": "c" } });
    expect((await pgError(h.db.insert(consentWordings).values({ purpose: "events", version: 7, text: { en: "x" } }))).message).toContain("consent_wordings_purpose_version_uq");
  });
});

describe("declarations view", () => {
  it("3.54 v_declaration_current returns the latest row per person and kind with is_valid", async () => {
    const [minor, guardian] = [await makePerson(h.db, { birthOn: "2015-05-01" }), await makePerson(h.db)];
    const v1 = crypto.randomUUID();
    const v2 = crypto.randomUUID();
    const base = { personId: minor.id, kind: "guardian_consent" as const, guardianPersonId: guardian.id, method: "reception" as const, actor: SYSTEM };
    await h.db.insert(personDeclarations).values({ ...base, documentVersionId: v1, documentVersion: 1, acceptedAt: new Date("2026-01-01T00:00:00Z") });
    await h.db.insert(personDeclarations).values({ ...base, documentVersionId: v2, documentVersion: 2, acceptedAt: new Date("2026-02-01T00:00:00Z") });
    const current = async () =>
      rows<{ document_version_id: string; status: string; is_valid: boolean }>(
        await h.db.execute(sql`select document_version_id, status, is_valid from v_declaration_current where person_id = ${minor.id}`),
      );
    expect(await current()).toEqual([{ document_version_id: v2, status: "accepted", is_valid: true }]);
    await h.db.insert(personDeclarations).values({ ...base, documentVersionId: v2, documentVersion: 2, status: "revoked", acceptedAt: new Date("2026-03-01T00:00:00Z") });
    expect(await current()).toEqual([{ document_version_id: v2, status: "revoked", is_valid: false }]);
    const other = await makePerson(h.db, { birthOn: "2014-05-01" });
    await h.db.insert(personDeclarations).values({ ...base, personId: other.id, documentVersionId: v2, documentVersion: 2, expiresAt: new Date("2020-01-01T00:00:00Z") });
    const [expired] = rows<{ is_valid: boolean }>(await h.db.execute(sql`select is_valid from v_declaration_current where person_id = ${other.id}`));
    expect(expired!.is_valid).toBe(false);
  });
});

describe("status override conflicts", () => {
  it("3.11 lists persons whose override differs from the derived status (fixture v_person_status)", async () => {
    expect(vStatusOverrideConflictsSql === undefined).toBe(!("vPersonStatusSql" in schemaIndex));
    await h.db.execute(sql`create table fx_derived (person_id uuid primary key, derived_status text not null)`);
    await h.db.execute(sql`create view fx_v_person_status as select person_id, derived_status from fx_derived`);
    await h.db.execute(
      sql.raw(`create view fx_v_status_override_conflicts as ${STATUS_OVERRIDE_CONFLICTS_DEFINITION.replace("v_person_status", "fx_v_person_status")}`),
    );
    const differs = await makePerson(h.db, { statusOverride: "lead", statusOverrideReason: "manual check" });
    const agrees = await makePerson(h.db, { statusOverride: "customer", statusOverrideReason: "manual check" });
    const none = await makePerson(h.db);
    const erased = await makePerson(h.db, { statusOverride: "member", statusOverrideReason: "manual check", erasedAt: new Date() });
    for (const id of [differs.id, agrees.id, none.id, erased.id]) await h.db.execute(sql`insert into fx_derived values (${id}, 'customer')`);
    const r = rows<{ person_id: string; status_override: string; derived_status: string }>(await h.db.execute(sql`select person_id, status_override, derived_status from fx_v_status_override_conflicts`));
    expect(r).toEqual([{ person_id: differs.id, status_override: "lead", derived_status: "customer" }]);
  });
});

describe("tags, segments, tasks, companies", () => {
  it("checks tag keys and colours", async () => {
    expect((await pgError(h.db.insert(tags).values({ key: "Bad Key", name: { en: "x" } }))).message).toContain("tags_key_ck");
    expect((await pgError(h.db.insert(tags).values({ key: "ok_key", name: { en: "x" }, color: "red" }))).message).toContain("tags_color_ck");
  });

  it("a segment cannot exclude itself", async () => {
    const [s] = await h.db.insert(segments).values({ name: "Leads", kind: "dynamic" }).returning();
    expect(s!.definition).toEqual({ op: "and", rules: [] });
    expect(s!.excludeSegmentIds).toEqual([]);
    expect((await pgError(h.db.execute(sql`update segments set exclude_segment_ids = array[id] where id = ${s!.id}`))).message).toContain("segments_no_self_exclusion_ck");
  });

  it("3.42 a task is done exactly when done_at is set; v_open_tasks flags overdue tasks", async () => {
    const owner = await makeUser(h.db);
    const base = { ownerUserId: owner.id, title: "Call back", kind: "call" as const, createdBy: SYSTEM };
    expect((await pgError(h.db.insert(tasks).values({ ...base, status: "done" }))).message).toContain("tasks_done_at_ck");
    expect((await pgError(h.db.insert(tasks).values({ ...base, title: "" }))).message).toContain("tasks_title_ck");
    const [overdue] = await h.db.insert(tasks).values({ ...base, dueAt: new Date(Date.now() - 3_600_000 * 48) }).returning();
    const [later] = await h.db.insert(tasks).values({ ...base, dueAt: new Date(Date.now() + 3_600_000 * 72) }).returning();
    await h.db.insert(tasks).values({ ...base, status: "done", doneAt: new Date() });
    const open = rows<{ id: string; is_overdue: boolean; is_due_today: boolean }>(await h.db.execute(sql`select id, is_overdue, is_due_today from v_open_tasks where owner_user_id = ${owner.id}`));
    expect(open.length).toBe(2);
    expect(open.find((t) => t.id === overdue!.id)).toMatchObject({ is_overdue: true, is_due_today: false });
    expect(open.find((t) => t.id === later!.id)).toMatchObject({ is_overdue: false, is_due_today: false });
    expect((await pgError(h.db.insert(tasks).values({ ...base, dedupeKey: "k1" }).then(() => h.db.insert(tasks).values({ ...base, dedupeKey: "k1" })))).message).toContain("tasks_dedupe_key_unique");
  });

  it("3.45 company VAT numbers are normalised-format and unique; one primary contact per company", async () => {
    expect((await pgError(h.db.insert(companies).values({ name: "Bad", vatNumber: "be 0123.456.789" }))).message).toContain("companies_vat_number_ck");
    await h.db.insert(companies).values({ name: "A", vatNumber: "BE0123456789" });
    expect((await pgError(h.db.insert(companies).values({ name: "B", vatNumber: "BE0123456789" }))).message).toContain("companies_vat_number_uq");
    expect((await pgError(h.db.insert(companies).values({ name: "C", partnerCommissionPct: "120" }))).message).toContain("companies_partner_commission_ck");
    const [c] = await h.db.insert(companies).values({ name: "D" }).returning();
    const [p1, p2] = [await makePerson(h.db), await makePerson(h.db)];
    await h.db.insert(companyContacts).values({ companyId: c!.id, personId: p1.id, isPrimary: true });
    expect((await pgError(h.db.insert(companyContacts).values({ companyId: c!.id, personId: p2.id, isPrimary: true }))).message).toContain("company_contacts_primary_uq");
    await h.db.execute(sql`update company_contacts set ended_on = current_date where person_id = ${p1.id}`);
    await h.db.insert(companyContacts).values({ companyId: c!.id, personId: p2.id, isPrimary: true });
  });
});

describe("allow-lists and seed", () => {
  it("3.27 no SENSITIVE_COLUMNS member is a segment field or event data key", () => {
    const sensitive = new Set(SENSITIVE_COLUMNS.flatMap((c) => [c.column, `${c.table}.${c.column}`]));
    expect(sensitive.has("value_enc")).toBe(true);
    for (const f of SEGMENT_ALLOWED_FIELDS) expect(sensitive.has(f), f).toBe(false);
    for (const k of SEGMENT_ALLOWED_EVENT_KINDS) expect(k.startsWith("note.") || k.startsWith("sensitive.")).toBe(false);
  });

  it("seeds system tags and every consent wording v1 in three locales, idempotently", async () => {
    await crmSeed.run(h.db, {});
    await crmSeed.run(h.db, {});
    const t = rows<{ key: string; is_system: boolean }>(await h.db.execute(sql`select key, is_system from tags where is_system order by key`));
    expect(t.map((x) => x.key)).toEqual(["interest:breathwork", "interest:events", "interest:sleep", "vip"]);
    const w = rows<{ purpose: string; text: Record<string, string> }>(await h.db.execute(sql`select purpose::text, text from consent_wordings where version = 1 order by purpose`));
    expect(w.length).toBe(7);
    for (const row of w) expect(Object.keys(row.text).sort()).toEqual(["en", "fr-BE", "nl-BE"]);
  });
});
