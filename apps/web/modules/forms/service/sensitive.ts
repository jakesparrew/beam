/**
 * Sensitive answers (forms spec rules SE1 to SE5, S6). Values of `sensitive_field_keys` and of
 * sensitive dimensions (`score:<key>`) are written only here, encrypted with platform's
 * `encryptSensitive(JSON.stringify(value), aad)` and the AAD of section 2. Decryption happens
 * only through platform's `readSensitive()` (SE3); this file never decrypts.
 */
import type { DbOrTx } from "@beam/db";
import { formSensitiveAnswers } from "@beam/db/schema";
import type { Answers, FormDefinition } from "@beam/core/forms";
import { and, eq, inArray, notInArray, type Ctx } from "@/lib/ctx";
import { encryptSensitive, readSensitive, sensitiveAad, type SensitivePurpose } from "@/lib/sensitive";

/** The field key of a sensitive dimension value. */
export const scoreKey = (dimensionKey: string): string => `score:${dimensionKey}`;

/** SE2: true when a `sensitive_processing` consent field is ticked in `answers`. */
export function hasSensitiveConsent(def: FormDefinition, answers: Answers): boolean {
  return Object.values(def.fields).some((f) => f.type === "consent" && f.purpose === "sensitive_processing" && answers[f.key] === true);
}

/** The key of the form's `sensitive_processing` consent field, if any. */
export function sensitiveConsentKey(def: FormDefinition): string | null {
  return Object.values(def.fields).find((f) => f.type === "consent" && f.purpose === "sensitive_processing")?.key ?? null;
}

/** Encrypts and upserts one row per key (the AAD binds each value to its submission and key). */
export async function storeSensitive(tx: DbOrTx, i: { submissionId: string; personId: string | null; values: Record<string, unknown> }): Promise<number> {
  let n = 0;
  for (const [fieldKey, value] of Object.entries(i.values)) {
    if (value === undefined) continue;
    const { valueEnc, keyVersion } = encryptSensitive(JSON.stringify(value), sensitiveAad.formAnswer(i.submissionId, fieldKey));
    await tx
      .insert(formSensitiveAnswers)
      .values({ submissionId: i.submissionId, personId: i.personId, fieldKey, valueEnc, keyVersion })
      .onConflictDoUpdate({
        target: [formSensitiveAnswers.submissionId, formSensitiveAnswers.fieldKey],
        set: { valueEnc, keyVersion, personId: i.personId, updatedAt: new Date() },
      });
    n++;
  }
  return n;
}

/** Deletes the sensitive rows of a submission whose key is not in `keep` (answers of now-hidden fields). */
export async function deleteSensitiveExcept(tx: DbOrTx, submissionId: string, keep: readonly string[]): Promise<void> {
  const where = keep.length
    ? and(eq(formSensitiveAnswers.submissionId, submissionId), notInArray(formSensitiveAnswers.fieldKey, [...keep]))
    : eq(formSensitiveAnswers.submissionId, submissionId);
  await tx.delete(formSensitiveAnswers).where(where);
}

/** Links the sensitive rows of a submission to its person (ID3, ID9). */
export async function linkSensitive(tx: DbOrTx, submissionId: string, personId: string): Promise<void> {
  await tx.update(formSensitiveAnswers).set({ personId, updatedAt: new Date() }).where(eq(formSensitiveAnswers.submissionId, submissionId));
}

/** The stored sensitive keys of submissions (never the values). */
export async function sensitiveKeysOf(tx: DbOrTx, submissionIds: readonly string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (!submissionIds.length) return out;
  const rows = await tx
    .select({ submissionId: formSensitiveAnswers.submissionId, fieldKey: formSensitiveAnswers.fieldKey })
    .from(formSensitiveAnswers)
    .where(inArray(formSensitiveAnswers.submissionId, [...submissionIds]));
  for (const r of rows) out.set(r.submissionId, [...(out.get(r.submissionId) ?? []), r.fieldKey]);
  return out;
}

export type SensitiveAnswer = { submissionId: string; fieldKey: string; value: unknown };

/**
 * SE3: the decrypted answers of the person's submissions through `readSensitive` (which checks
 * the purpose and writes `sensitive.read` with keys only). Values are parsed back from JSON.
 */
export async function readSubmissionAnswers(ctx: Ctx, personId: string, purpose: SensitivePurpose, submissionIds?: string[]): Promise<SensitiveAnswer[]> {
  const bundle = await readSensitive(ctx, personId, purpose, submissionIds ? { submissionIds } : undefined);
  return bundle.formAnswers.map((a) => ({ submissionId: a.submissionId, fieldKey: a.fieldKey, value: parseValue(a.value) }));
}

function parseValue(v: string): unknown {
  try {
    return JSON.parse(v) as unknown;
  } catch {
    return v;
  }
}
