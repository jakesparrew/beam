import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, makePerson } from "@beam/db/testing";
import type { DbHandle } from "@beam/db";
import { auditLog, formSensitiveAnswers, formSubmissions, formVersions, forms, personSensitiveFields } from "@beam/db/schema";
import { ForbiddenError, PermanentError } from "@beam/core/errors";
import { eq, sql } from "./ctx";
import {
  decryptSensitive,
  encryptNote,
  encryptSensitive,
  readSensitive,
  rekeyChunk,
  rowsOf,
  sensitiveAad,
  setCurrentKeyVersion,
} from "./sensitive";
import { makeCtx, resetRuntime, staffActor } from "./testing";

let handle: DbHandle;
let form: { formId: string; formVersionId: string };
const KEY1 = Buffer.alloc(32, 1).toString("base64");
const KEY2 = Buffer.alloc(32, 2).toString("base64");

beforeAll(async () => {
  process.env.SENSITIVE_DATA_KEY_V1 = KEY1;
  process.env.SENSITIVE_DATA_KEY_V2 = KEY2;
  handle = await createTestDb();
  // The real forms tables (forms-P1): one intake form with a published version holding a sensitive field.
  const [f] = await handle.db
    .insert(forms)
    .values({ slug: "sensitive-intake", kind: "intake", name: { "nl-BE": "Intake", "fr-BE": "Accueil", en: "Intake" } })
    .returning();
  const [v] = await handle.db
    .insert(formVersions)
    .values({ formId: f!.id, version: 1, definition: { sections: [] }, sensitiveFieldKeys: ["medical"], definitionHash: "0".repeat(64), publishedAt: new Date() })
    .returning();
  await handle.db.update(forms).set({ status: "published", currentVersionId: v!.id }).where(eq(forms.id, f!.id));
  form = { formId: f!.id, formVersionId: v!.id };
});
afterAll(async () => {
  setCurrentKeyVersion(1);
  process.env.SENSITIVE_DATA_KEY_V1 = KEY1;
  delete process.env.SENSITIVE_DATA_KEY_V2;
  resetRuntime();
  await handle.close();
});

async function seedPerson() {
  const person = await makePerson(handle.db);
  for (const [key, value] of [
    ["sleep", "5 hours"],
    ["stress", "high"],
  ] as const) {
    const enc = encryptSensitive(value, sensitiveAad.personField(person.id, key));
    await handle.db.insert(personSensitiveFields).values({ personId: person.id, key, valueEnc: Buffer.from(enc.valueEnc), keyVersion: enc.keyVersion });
  }
  const [sub] = await handle.db
    .insert(formSubmissions)
    .values({ ...form, personId: person.id, status: "completed", completedAt: new Date(), identifiedBy: "email", funnel: "form:sensitive-intake", locale: "nl-BE" })
    .returning({ id: formSubmissions.id });
  const submissionId = sub!.id;
  const ans = encryptSensitive(JSON.stringify("sore back"), sensitiveAad.formAnswer(submissionId, "medical"));
  await handle.db.insert(formSensitiveAnswers).values({ submissionId, personId: person.id, fieldKey: "medical", valueEnc: Buffer.from(ans.valueEnc), keyVersion: ans.keyVersion });
  const { id: eventId } = await makeCtx(handle.db).recordEvent({ kind: "platform.password_set", personId: person.id, data: encryptNote(person.id, "panic attacks"), isSensitive: true });
  return { person, submissionId, eventId: String(eventId) };
}

const reader = (permissions: string[] = ["persons.sensitive_read"]) => makeCtx(handle.db, staffActor({ permissions }));
const system = () => makeCtx(handle.db, { kind: "system", jobId: crypto.randomUUID() });

describe("encryption (PL-69)", () => {
  it("round trips and binds the value to its AAD", () => {
    const { valueEnc, keyVersion } = encryptSensitive("knee injury", "person_sensitive_fields:p1:health_note");
    expect(valueEnc[0]).toBe(0x01);
    expect(valueEnc.length).toBe(1 + 12 + "knee injury".length + 16);
    expect(decryptSensitive(valueEnc, keyVersion, "person_sensitive_fields:p1:health_note")).toBe("knee injury");
    expect(() => decryptSensitive(valueEnc, keyVersion, "person_sensitive_fields:p2:health_note")).toThrow(PermanentError);
  });

  it("reads a value written with an older key version", () => {
    const old = encryptSensitive("v1 secret", "aad");
    setCurrentKeyVersion(2);
    const fresh = encryptSensitive("v2 secret", "aad");
    expect(fresh.keyVersion).toBe(2);
    expect(decryptSensitive(old.valueEnc, old.keyVersion, "aad")).toBe("v1 secret");
    expect(decryptSensitive(fresh.valueEnc, 2, "aad")).toBe("v2 secret");
    setCurrentKeyVersion(1);
  });

  it("a missing key is a PermanentError (edge case 18)", () => {
    expect(() => encryptSensitive("x", "aad", 9)).toThrow(PermanentError);
    expect(() => encryptSensitive("x", "aad", 9)).toThrow(/missing_key/);
  });
});

describe("readSensitive (PL-22)", () => {
  it("staff_view needs persons.sensitive_read", async () => {
    const { person } = await seedPerson();
    await expect(readSensitive(reader([]), person.id, "staff_view")).rejects.toBeInstanceOf(ForbiddenError);
    expect(await handle.db.select().from(auditLog).where(eq(auditLog.personId, person.id))).toHaveLength(0);
  });

  it("staff_view with the permission returns everything and audits keys and ids, never values", async () => {
    const { person, submissionId, eventId } = await seedPerson();
    const bundle = await readSensitive(reader(), person.id, "staff_view");
    expect(bundle.fields).toEqual({ sleep: "5 hours", stress: "high" });
    expect(bundle.formAnswers).toEqual([{ submissionId, fieldKey: "medical", value: "sore back" }]);
    expect(bundle.notes).toEqual([{ eventId, body: "panic attacks" }]);
    const [row] = await handle.db.select().from(auditLog).where(eq(auditLog.personId, person.id));
    expect(row).toMatchObject({ action: "sensitive.read", entityType: "person", entityId: person.id });
    expect(row!.newValue).toEqual({ purpose: "staff_view", field_keys: ["sleep", "stress"], submission_ids: [submissionId], event_ids: [eventId] });
    const text = JSON.stringify(row);
    for (const v of ["5 hours", "high", "sore back", "panic attacks"]) expect(text).not.toContain(v);
  });

  it("a scope narrows what is decrypted", async () => {
    const { person, eventId } = await seedPerson();
    const bundle = await readSensitive(reader(), person.id, "staff_view", { eventIds: [eventId] });
    expect(bundle).toEqual({ fields: {}, formAnswers: [], notes: [{ eventId, body: "panic attacks" }] });
    const keys = await readSensitive(reader(), person.id, "staff_view", { keys: ["sleep"] });
    expect(keys).toEqual({ fields: { sleep: "5 hours" }, formAnswers: [], notes: [] });
  });

  it("privacy_export needs the system actor", async () => {
    const { person } = await seedPerson();
    await expect(readSensitive(reader(["*"]), person.id, "privacy_export")).rejects.toBeInstanceOf(ForbiddenError);
    const bundle = await readSensitive(system(), person.id, "privacy_export");
    expect(Object.keys(bundle.fields).sort()).toEqual(["sleep", "stress"]);
  });

  it("subject_result needs submissionIds of the person's own submissions", async () => {
    const mine = await seedPerson();
    const other = await seedPerson();
    await expect(readSensitive(system(), mine.person.id, "subject_result")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(readSensitive(system(), mine.person.id, "subject_result", { submissionIds: [] })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(readSensitive(system(), mine.person.id, "subject_result", { submissionIds: [other.submissionId] })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(readSensitive(reader(), mine.person.id, "subject_result", { submissionIds: [mine.submissionId] })).rejects.toBeInstanceOf(ForbiddenError);
    const bundle = await readSensitive(system(), mine.person.id, "subject_result", { submissionIds: [mine.submissionId] });
    expect(bundle).toEqual({ fields: {}, notes: [], formAnswers: [{ submissionId: mine.submissionId, fieldKey: "medical", value: "sore back" }] });
  });

  it("an unknown purpose is forbidden", async () => {
    const { person } = await seedPerson();
    await expect(readSensitive(system(), person.id, "care" as never)).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("security.rekey chunks (PL-70)", () => {
  it("re-encrypts rows below the target version; a second run changes nothing", async () => {
    const { person, submissionId, eventId } = await seedPerson();
    for (const table of ["person_sensitive_fields", "form_sensitive_answers", "activity_events", "users"] as const) {
      // The job runs each chunk in its own transaction (SET LOCAL beam.allow_rewrite for activity_events).
      const first = await handle.db.transaction((tx) => rekeyChunk(tx, { toVersion: 2, table }));
      expect(first.done).toBe(true);
      // Rows seeded by this and earlier tests are all at version 1 (no user has a TOTP secret here).
      if (table !== "users") expect(first.rows).toBeGreaterThan(0);
      expect((await handle.db.transaction((tx) => rekeyChunk(tx, { toVersion: 2, table }))).rows).toBe(0);
    }
    const count = async (q: ReturnType<typeof sql>) => rowsOf<{ n: number }>(await handle.db.execute(q))[0]!.n;
    expect(await count(sql`select count(*)::int as n from person_sensitive_fields where person_id = ${person.id} and key_version <> 2`)).toBe(0);
    expect(await count(sql`select count(*)::int as n from form_sensitive_answers where person_id = ${person.id} and key_version <> 2`)).toBe(0);
    expect(await count(sql`select count(*)::int as n from person_sensitive_fields where key_version <> 2`)).toBe(0);
    expect(await count(sql`select count(*)::int as n from form_sensitive_answers where key_version <> 2`)).toBe(0);
    expect(await count(sql`select (data->>'key_version')::int as n from activity_events where id = ${eventId}::bigint`)).toBe(2);
    // Without the version 1 key, a row left at version 1 would fail to decrypt.
    delete process.env.SENSITIVE_DATA_KEY_V1;
    setCurrentKeyVersion(2);
    const bundle = await readSensitive(system(), person.id, "privacy_export");
    expect(bundle.fields).toEqual({ sleep: "5 hours", stress: "high" });
    expect(bundle.formAnswers).toEqual([{ submissionId, fieldKey: "medical", value: "sore back" }]);
    expect(bundle.notes).toEqual([{ eventId, body: "panic attacks" }]);
    process.env.SENSITIVE_DATA_KEY_V1 = KEY1;
    setCurrentKeyVersion(1);
    await expect(rekeyChunk(handle.db, { toVersion: 7, table: "users" })).rejects.toThrow(/missing_key/);
  });
});
