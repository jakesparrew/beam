/**
 * crm-P7 privacy registration (crm spec 9) on PGlite: the export holds every table of section 9
 * and the subject's decrypted sensitive data; each non-`keep` retention key has a sweep handler;
 * erase leaves no crm row referencing the person except the anonymised `persons` row, hash-only
 * `suppressions` and (R3) anonymised `opportunities`; erasing a merged winner erases the loser.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, makePerson, makeUser } from "@beam/db/testing";
import type { DbHandle } from "@beam/db";
import {
  activityEvents,
  companies,
  companyContacts,
  consentRecords,
  personDeclarations,
  personDuplicateCandidates,
  personMerges,
  personSensitiveFields,
  personTags,
  persons,
  segmentMembers,
  segments,
  suppressions,
  tags,
  tasks,
} from "@beam/db/schema";
import { emailHash } from "@beam/core/crm";

process.env.SENSITIVE_DATA_KEY_V1 ??= randomBytes(32).toString("base64");
vi.mock("next/server", () => ({ after: () => undefined }));

const { privacy, retention, sweep, noPiiTables } = await import("./privacy");
const { eq, inArray, setAppDb, sql } = await import("@/lib/ctx");
const { encryptNote, encryptSensitive, rowsOf, sensitiveAad } = await import("@/lib/sensitive");
const { resetRuntime } = await import("@/lib/testing");

let h: DbHandle;
let staffId: string;
const ACTOR = () => ({ kind: "staff" as const, id: staffId });

beforeAll(async () => {
  h = await createTestDb();
  setAppDb(h.db);
  staffId = (await makeUser(h.db, { roleKey: "owner" })).id;
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});

type Subject = { id: string; email: string; secret: string; note: string; minorId: string };

/** A person with a row in every crm table of section 9. */
async function seedSubject(): Promise<Subject> {
  const email = `subject-${randomUUID().slice(0, 8)}@example.com`;
  const p = await makePerson(h.db, { email, emailHash: emailHash(email), phone: "0470 12 34 56", birthOn: "1985-02-03", emergencyContact: { name: "Kim", phone: "+32470000000" } });
  const other = await makePerson(h.db);
  const minor = await makePerson(h.db, { birthOn: "2015-01-01" });
  const secret = `sleep apnoea ${randomUUID().slice(0, 6)}`;
  const note = `panic attacks ${randomUUID().slice(0, 6)}`;
  const enc = encryptSensitive(secret, sensitiveAad.personField(p.id, "sleep"));
  await h.db.insert(personSensitiveFields).values({ personId: p.id, key: "sleep", valueEnc: enc.valueEnc, keyVersion: enc.keyVersion });
  const [a, b] = [p.id, other.id].sort();
  await h.db.insert(personDuplicateCandidates).values({ personAId: a!, personBId: b!, score: 70, reasons: ["name_birth"] });
  const versionId = randomUUID();
  await h.db.insert(personDeclarations).values({ personId: minor.id, kind: "guardian_consent", documentVersionId: versionId, documentVersion: 1, method: "reception", guardianPersonId: p.id, actor: ACTOR() });
  await h.db.insert(personDeclarations).values({ personId: p.id, kind: "guardian_consent", documentVersionId: versionId, documentVersion: 1, method: "portal", guardianPersonId: other.id, actor: ACTOR() });
  await h.db.insert(consentRecords).values({ personId: p.id, purpose: "newsletter", status: "granted", source: "portal", method: "portal", wordingVersion: "newsletter@1", actor: ACTOR() });
  await h.db.insert(suppressions).values({ emailHash: emailHash(email), email, scope: "newsletter", reason: "unsubscribe", source: "portal", personId: p.id, actor: ACTOR() });
  await h.db.insert(activityEvents).values({ kind: "tag.added", personId: p.id, actor: ACTOR(), data: { tag_key: "vip", source: "manual" } });
  await h.db.insert(activityEvents).values({ kind: "note.added", personId: p.id, actor: ACTOR(), isSensitive: true, data: encryptNote(p.id, note) });
  const [tag] = await h.db.insert(tags).values({ key: `t-${randomUUID().slice(0, 8)}`, name: { en: "T", "nl-BE": "T", "fr-BE": "T" } }).returning();
  await h.db.insert(personTags).values({ personId: p.id, tagId: tag!.id, source: "manual", addedBy: ACTOR() });
  const [seg] = await h.db.insert(segments).values({ name: `Segment ${randomUUID().slice(0, 6)}`, kind: "static" }).returning();
  await h.db.insert(segmentMembers).values({ segmentId: seg!.id, personId: p.id, source: "manual" });
  await h.db.insert(tasks).values({ ownerUserId: staffId, personId: p.id, title: "Call back about the membership", kind: "call", createdBy: ACTOR() });
  const [co] = await h.db.insert(companies).values({ name: `Company ${randomUUID().slice(0, 6)}` }).returning();
  await h.db.insert(companyContacts).values({ companyId: co!.id, personId: p.id, position: "HR" });
  await h.db.insert(activityEvents).values({ kind: "company.updated", companyId: co!.id, actor: ACTOR(), data: { fields: ["name"] } });
  return { id: p.id, email, secret, note, minorId: minor.id };
}

/** Every (table, column) of a crm table with a foreign key to `persons.id`. */
async function personReferences(): Promise<Array<{ table: string; column: string }>> {
  const rows = rowsOf<{ table_name: string; column_name: string }>(
    await h.db.execute(sql`
      select distinct kcu.table_name, kcu.column_name
      from information_schema.table_constraints tc
      join information_schema.key_column_usage kcu on kcu.constraint_name = tc.constraint_name and kcu.table_schema = tc.table_schema
      join information_schema.constraint_column_usage ccu on ccu.constraint_name = tc.constraint_name and ccu.table_schema = tc.table_schema
      where tc.constraint_type = 'FOREIGN KEY' and ccu.table_name = 'persons' and ccu.column_name = 'id' and tc.table_schema = 'public'`),
  );
  const crmTables = new Set<string>(privacy.tables);
  // `persons` itself stays (anonymised); a merged loser keeps pointing at its anonymised winner.
  return rows.filter((r) => crmTables.has(r.table_name) && r.table_name !== "persons").map((r) => ({ table: r.table_name, column: r.column_name }));
}

async function referencing(ids: string[]): Promise<string[]> {
  const left: string[] = [];
  for (const { table, column } of await personReferences()) {
    const list = sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `);
    const [r] = rowsOf<{ n: number }>(await h.db.execute(sql`select count(*)::int as n from ${sql.identifier(table)} where ${sql.identifier(column)} in (${list})`));
    if (Number(r?.n ?? 0) > 0) left.push(`${table}.${column}`);
  }
  return left;
}

const erase = (id: string) => h.db.transaction((tx) => privacy.erase(tx, id));
const exportOf = (id: string) => h.db.transaction((tx) => privacy.export(tx, id));

describe("crm privacy registration (spec 9)", () => {
  it("export contains every table of section 9 and the decrypted sensitive data", async () => {
    const s = await seedSubject();
    const out = await exportOf(s.id);
    for (const table of ["persons", "person_sensitive_fields", "person_merges", "person_declarations", "consent_records", "suppressions", "activity_events", "person_tags", "segment_members", "tasks", "company_contacts"]) {
      expect(out, table).toHaveProperty(table);
    }
    expect(out).not.toHaveProperty("person_duplicate_candidates");
    expect(out.person_sensitive_fields).toEqual([{ person_id: s.id, key: "sleep", value: s.secret }]);
    const events = out.activity_events as Array<{ kind: string; is_sensitive: boolean; data: { body?: string } }>;
    expect(events.find((e) => e.is_sensitive)?.data.body).toBe(s.note);
    expect((out.persons as Array<{ email: string }>)[0]!.email).toBe(s.email);
    expect((out.persons as Array<Record<string, unknown>>)[0]).not.toHaveProperty("search_tsv");
    expect((out.tasks as unknown[]).length).toBe(1);
    expect((out.consent_records as unknown[]).length).toBe(1);
    expect(String(out.timeline_csv)).toContain("tag.added");
    // the export reads sensitive data as the system actor and is audited with keys only
    const audit = rowsOf<{ new_value: unknown }>(await h.db.execute(sql`select new_value from audit_log where action = 'sensitive.read' and person_id = ${s.id}`));
    expect(audit.length).toBeGreaterThan(0);
    expect(JSON.stringify(audit)).not.toContain(s.secret);
  });

  it("each non-keep retention key has a sweep handler", () => {
    for (const r of retention) {
      if (r.action === "keep") expect(r.days).toBeNull();
      else expect(typeof sweep[r.key], r.key).toBe("function");
    }
    expect(noPiiTables).toContain("tags");
  });

  it("erase leaves only the anonymised person, hash-only suppressions and no other crm reference", async () => {
    const s = await seedSubject();
    const report = await erase(s.id);
    expect(report.every((r) => typeof r.rows === "number" && typeof r.action === "string")).toBe(true);
    expect(JSON.stringify(report)).not.toContain(s.email);

    const refs = (await personReferences()).map((r) => `${r.table}.${r.column}`);
    expect(refs).toEqual(expect.arrayContaining(["activity_events.person_id", "consent_records.person_id", "person_sensitive_fields.person_id", "tasks.person_id", "suppressions.person_id"]));
    expect(await referencing([s.id])).toEqual([]);
    const [p] = await h.db.select().from(persons).where(eq(persons.id, s.id));
    expect(p).toMatchObject({ firstName: "Deleted", lastName: "person", email: null, emailHash: null, phone: null, phoneE164: null, birthOn: null, emergencyContact: null, address: null, externalIds: {} });
    expect(p!.erasedAt).not.toBeNull();
    expect(p!.acquisition).toEqual({ source: "manual" });

    const supp = await h.db.select().from(suppressions).where(eq(suppressions.emailHash, emailHash(s.email)));
    expect(supp.map((x) => [x.scope, x.reason]).sort()).toEqual([
      ["all", "erased"],
      ["newsletter", "unsubscribe"],
    ]);
    expect(supp.every((x) => x.email === null && x.personId === null)).toBe(true);

    // company-only timeline rows stay; the minor's guardian consent signed by the subject is gone
    expect((await h.db.select().from(activityEvents).where(eq(activityEvents.kind, "company.updated"))).length).toBeGreaterThan(0);
    expect(await h.db.select().from(personDeclarations).where(eq(personDeclarations.personId, s.minorId))).toEqual([]);
  });

  it("erasing a merged winner also erases the loser", async () => {
    const winner = await seedSubject();
    const loser = await makePerson(h.db, { phone: "0499 99 99 99" });
    await h.db.insert(activityEvents).values({ kind: "tag.added", personId: loser.id, actor: ACTOR(), data: { tag_key: "x", source: "manual" } });
    await h.db.insert(personMerges).values({ winnerPersonId: winner.id, loserPersonId: loser.id, loserSnapshot: { email: loser.email }, mergedByUserId: staffId });
    await h.db.update(persons).set({ mergedIntoPersonId: winner.id }).where(eq(persons.id, loser.id));

    const out = await exportOf(winner.id);
    expect((out.persons as unknown[]).length).toBe(2);
    expect((out.person_merges as unknown[]).length).toBe(1);

    await erase(winner.id);
    expect(await referencing([winner.id, loser.id])).toEqual([]);
    const rows = await h.db.select().from(persons).where(inArray(persons.id, [winner.id, loser.id]));
    expect(rows.every((r) => r.erasedAt !== null && r.email === null && r.phone === null && r.firstName === "Deleted")).toBe(true);
  });

  it("erase twice is harmless", async () => {
    const s = await seedSubject();
    await erase(s.id);
    await expect(erase(s.id)).resolves.toBeDefined();
    expect(await referencing([s.id])).toEqual([]);
  });
});
