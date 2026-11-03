import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, makePerson } from "@beam/db/testing";
import type { DbHandle } from "@beam/db";
import { auditLog } from "@beam/db/schema";
import { ForbiddenError, PermanentError } from "@beam/core/errors";
import { eq, sql } from "./ctx";
import {
  decryptSensitive,
  encryptNote,
  encryptSensitive,
  readSensitive,
  rekeyChunk,
  sensitiveAad,
  setCurrentKeyVersion,
} from "./sensitive";
import { makeCtx, resetRuntime, staffActor } from "./testing";

let handle: DbHandle;
const KEY1 = Buffer.alloc(32, 1).toString("base64");
const KEY2 = Buffer.alloc(32, 2).toString("base64");

beforeAll(async () => {
  process.env.SENSITIVE_DATA_KEY_V1 = KEY1;
  process.env.SENSITIVE_DATA_KEY_V2 = KEY2;
  handle = await createTestDb();
  // The owners' tables (crm-P?, forms) do not exist yet in Wave 0: create their contract shape here.
  await handle.db.execute(sql`create table person_sensitive_fields (
    id uuid primary key default gen_random_uuid(), person_id uuid not null references persons(id) on delete cascade,
    key text not null, value_enc bytea not null, key_version smallint not null default 1, unique (person_id, key))`);
  await handle.db.execute(sql`create table form_submissions (id uuid primary key default gen_random_uuid(), person_id uuid references persons(id))`);
  await handle.db.execute(sql`create table form_sensitive_answers (
    id uuid primary key default gen_random_uuid(), submission_id uuid not null references form_submissions(id),
    person_id uuid references persons(id), field_key text not null, value_enc bytea not null, key_version smallint not null default 1)`);
});
afterAll(async () => {
  setCurrentKeyVersion(1);
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
    await handle.db.execute(sql`insert into person_sensitive_fields (person_id, key, value_enc, key_version) values (${person.id}, ${key}, ${Buffer.from(enc.valueEnc)}, ${enc.keyVersion})`);
  }
  const sub = (await handle.db.execute(sql`insert into form_submissions (person_id) values (${person.id}) returning id::text as id`)) as unknown as { rows: { id: string }[] };
  const submissionId = sub.rows[0]!.id;
  const ans = encryptSensitive(JSON.stringify("sore back"), sensitiveAad.formAnswer(submissionId, "medical"));
  await handle.db.execute(sql`insert into form_sensitive_answers (submission_id, person_id, field_key, value_enc) values (${submissionId}, ${person.id}, 'medical', ${Buffer.from(ans.valueEnc)})`);
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
    const { person } = await seedPerson();
    for (const table of ["person_sensitive_fields", "form_sensitive_answers", "activity_events", "users"] as const) {
      // The job runs each chunk in its own transaction (SET LOCAL beam.allow_rewrite for activity_events).
      const first = await handle.db.transaction((tx) => rekeyChunk(tx, { toVersion: 2, table }));
      expect(first.done).toBe(true);
      expect((await handle.db.transaction((tx) => rekeyChunk(tx, { toVersion: 2, table }))).rows).toBe(0);
    }
    setCurrentKeyVersion(2);
    const bundle = await readSensitive(system(), person.id, "privacy_export");
    expect(bundle.fields.sleep).toBe("5 hours");
    expect(bundle.notes[0]!.body).toBe("panic attacks");
    setCurrentKeyVersion(1);
    await expect(rekeyChunk(handle.db, { toVersion: 7, table: "users" })).rejects.toThrow(/missing_key/);
  });
});
