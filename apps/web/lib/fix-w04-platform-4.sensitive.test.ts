// Review fixes of fix-w04-platform-4 for lib/sensitive.ts (PL-22 subject_result scope, PL-69 key version).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, makePerson } from "@beam/db/testing";
import type { DbHandle } from "@beam/db";
import { auditLog, formSensitiveAnswers, formSubmissions, formVersions, forms, personSensitiveFields, settings } from "@beam/db/schema";
import { ForbiddenError } from "@beam/core/errors";
import { eq } from "./ctx";
import { currentKeyVersion, encryptNote, encryptSensitive, loadCurrentKeyVersion, readSensitive, sensitiveAad, setCurrentKeyVersion } from "./sensitive";
import { makeCtx, resetRuntime } from "./testing";

let handle: DbHandle;
let form: { formId: string; formVersionId: string };

beforeAll(async () => {
  process.env.SENSITIVE_DATA_KEY_V1 = Buffer.alloc(32, 1).toString("base64");
  process.env.SENSITIVE_DATA_KEY_V2 = Buffer.alloc(32, 2).toString("base64");
  handle = await createTestDb();
  const [f] = await handle.db
    .insert(forms)
    .values({ slug: "fix-intake", kind: "intake", name: { "nl-BE": "Intake", "fr-BE": "Accueil", en: "Intake" } })
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
  delete process.env.SENSITIVE_DATA_KEY_V2;
  resetRuntime();
  await handle.close();
});

const system = () => makeCtx(handle.db, { kind: "system", jobId: crypto.randomUUID() });

async function seed() {
  const person = await makePerson(handle.db);
  const enc = encryptSensitive("5 hours", sensitiveAad.personField(person.id, "sleep"), 1);
  await handle.db.insert(personSensitiveFields).values({ personId: person.id, key: "sleep", valueEnc: Buffer.from(enc.valueEnc), keyVersion: 1 });
  const [sub] = await handle.db
    .insert(formSubmissions)
    .values({ ...form, personId: person.id, status: "completed", completedAt: new Date(), identifiedBy: "email", funnel: "form:fix-intake", locale: "nl-BE" })
    .returning({ id: formSubmissions.id });
  const ans = encryptSensitive(JSON.stringify("sore back"), sensitiveAad.formAnswer(sub!.id, "medical"), 1);
  await handle.db.insert(formSensitiveAnswers).values({ submissionId: sub!.id, personId: person.id, fieldKey: "medical", valueEnc: Buffer.from(ans.valueEnc), keyVersion: 1 });
  const { id } = await makeCtx(handle.db).recordEvent({ kind: "platform.password_set", personId: person.id, data: encryptNote(person.id, "panic attacks", 1), isSensitive: true });
  return { personId: person.id, submissionId: sub!.id, eventId: String(id) };
}

describe("subject_result reads only form answers (PL-22)", () => {
  it("refuses a scope that also names field keys or event ids, before decrypting or auditing anything", async () => {
    const s = await seed();
    await expect(readSensitive(system(), s.personId, "subject_result", { submissionIds: [s.submissionId], keys: ["sleep"] })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(readSensitive(system(), s.personId, "subject_result", { submissionIds: [s.submissionId], eventIds: [s.eventId] })).rejects.toBeInstanceOf(ForbiddenError);
    expect(await handle.db.select().from(auditLog).where(eq(auditLog.personId, s.personId))).toHaveLength(0);
    // An empty list is no request for them.
    const ok = await readSensitive(system(), s.personId, "subject_result", { submissionIds: [s.submissionId], keys: [], eventIds: [] });
    expect(ok).toEqual({ fields: {}, notes: [], formAnswers: [{ submissionId: s.submissionId, fieldKey: "medical", value: "sore back" }] });
  });
});

describe("the key version comes from settings (PL-69)", () => {
  it("loadCurrentKeyVersion returns settings.security.current_key_version and makes it the default", async () => {
    setCurrentKeyVersion(1);
    await handle.db
      .insert(settings)
      .values({ key: "security", value: { current_key_version: 2 } })
      .onConflictDoUpdate({ target: settings.key, set: { value: { current_key_version: 2 } } });
    expect(await loadCurrentKeyVersion(handle.db)).toBe(2);
    expect(currentKeyVersion()).toBe(2);
    expect(encryptNote("p1", "x").key_version).toBe(2);
    expect(encryptNote("p1", "x", 1).key_version).toBe(1);
    setCurrentKeyVersion(1);
  });
});
