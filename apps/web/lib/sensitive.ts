/**
 * Special-category data (PL-22, PL-69). AES-256-GCM with a 12-byte random IV and an AAD that
 * binds the value to its row, stored as `0x01 || iv || ciphertext || tag`. Keys come from
 * `SENSITIVE_DATA_KEY_V<n>` (base64, 32 bytes); `settings.security.current_key_version` picks
 * the key for new writes, the row's `key_version` the key for reads.
 *
 * `readSensitive()` is the one reader. It checks the purpose before anything is decrypted and
 * writes audit `sensitive.read` with keys, submission ids and event ids, never values.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { DbOrTx } from "@beam/db";
import { ForbiddenError, PermanentError } from "@beam/core/errors";
import type { SensitiveFieldKey } from "@beam/core/privacy";
import { actorHasPermission, sql, type Ctx, type SQL } from "./ctx";
import type { Env } from "./integrations";

const FORMAT_VERSION = 0x01;
const IV_BYTES = 12;
const TAG_BYTES = 16;

let currentVersion = 1;

/** The key version new writes use (from `settings.security.current_key_version`). */
export function currentKeyVersion(): number {
  return currentVersion;
}

export function setCurrentKeyVersion(version: number): void {
  if (!Number.isInteger(version) || version < 1) throw new RangeError("key version must be an integer >= 1");
  currentVersion = version;
}

/** Reads `settings.security.current_key_version` and makes it the version for new writes. */
export async function loadCurrentKeyVersion(tx: DbOrTx): Promise<number> {
  const rows = rowsOf<{ v: number | string | null }>(
    await tx.execute(sql`select (value->>'current_key_version')::int as v from settings where key = 'security'`),
  );
  const v = Number(rows[0]?.v ?? 1);
  if (Number.isInteger(v) && v >= 1) currentVersion = v;
  return currentVersion;
}

/** The 32-byte key of a version, or `null` when its env var is missing or malformed. */
export function sensitiveKey(version: number, env: Env = process.env): Buffer | null {
  const raw = env[`SENSITIVE_DATA_KEY_V${version}`];
  if (!raw) return null;
  const key = Buffer.from(raw, "base64");
  return key.length === 32 ? key : null;
}

function requireKey(version: number): Buffer {
  const key = sensitiveKey(version);
  if (!key) throw new PermanentError(`missing_key: SENSITIVE_DATA_KEY_V${version}`);
  return key;
}

/** Encrypts with the current key version; throws `PermanentError('missing_key')` without the key. */
export function encryptSensitive(plain: string, aad: string, version: number = currentVersion): { valueEnc: Uint8Array; keyVersion: number } {
  const key = requireKey(version);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { valueEnc: new Uint8Array(Buffer.concat([Buffer.from([FORMAT_VERSION]), iv, ct, tag])), keyVersion: version };
}

/** Decrypts a value; a wrong key, AAD or a tampered value throws `PermanentError('decrypt_failed')`. */
export function decryptSensitive(valueEnc: Uint8Array, keyVersion: number, aad: string): string {
  const key = requireKey(keyVersion);
  const buf = Buffer.from(valueEnc);
  if (buf.length < 1 + IV_BYTES + TAG_BYTES || buf[0] !== FORMAT_VERSION) throw new PermanentError("decrypt_failed: bad format");
  const iv = buf.subarray(1, 1 + IV_BYTES);
  const tag = buf.subarray(buf.length - TAG_BYTES);
  const ct = buf.subarray(1 + IV_BYTES, buf.length - TAG_BYTES);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  } catch (error) {
    throw new PermanentError("decrypt_failed", { cause: error });
  }
}

// ---------------------------------------------------------------------------
// AADs of the three sensitive places and the two secret columns
// ---------------------------------------------------------------------------

export const sensitiveAad = {
  personField: (personId: string, key: string) => `person_sensitive_fields:${personId}:${key}`,
  formAnswer: (submissionId: string, fieldKey: string) => `form_sensitive_answers:${submissionId}:${fieldKey}`,
  /** A sensitive staff note (`activity_events` with `is_sensitive`): the event id is not known before insert. */
  note: (personId: string) => `activity_events:${personId}:note`,
  totpSecret: (userId: string) => `users.totp_secret:${userId}`,
  recoveryCodes: (userId: string) => `users.recovery_codes:${userId}`,
} as const;

/** The `data` of a sensitive `activity_events` row: `{ body_enc: base64, key_version }`. */
export function encryptNote(personId: string, body: string): { body_enc: string; key_version: number } {
  const { valueEnc, keyVersion } = encryptSensitive(body, sensitiveAad.note(personId));
  return { body_enc: Buffer.from(valueEnc).toString("base64"), key_version: keyVersion };
}

// ---------------------------------------------------------------------------
// readSensitive
// ---------------------------------------------------------------------------

export type SensitivePurpose = "staff_view" | "privacy_export" | "subject_result";

export type SensitiveBundle = {
  fields: Partial<Record<SensitiveFieldKey, string>>;
  formAnswers: { submissionId: string; fieldKey: string; value: string }[];
  notes: { eventId: string; body: string }[];
};

export type SensitiveScope = { keys?: SensitiveFieldKey[]; eventIds?: string[]; submissionIds?: string[] };

export function rowsOf<T>(result: unknown): T[] {
  if (result && typeof result === "object" && "rows" in result) return (result as { rows: T[] }).rows;
  return result as T[];
}

async function tableExists(tx: DbOrTx, table: string): Promise<boolean> {
  const rows = rowsOf<{ ok: boolean }>(await tx.execute(sql`select to_regclass(${`public.${table}`}) is not null as ok`));
  return !!rows[0]?.ok;
}

const list = (values: readonly string[]): SQL => sql`(${sql.join(values.map((v) => sql`${v}`), sql`, `)})`;

async function assertOwnSubmissions(tx: DbOrTx, personId: string, ids: readonly string[]): Promise<void> {
  const unique = [...new Set(ids)];
  let owned: number;
  if (await tableExists(tx, "form_submissions")) {
    const rows = rowsOf<{ n: number | string }>(
      await tx.execute(sql`select count(*)::int as n from form_submissions where id::text in ${list(unique)} and person_id = ${personId}`),
    );
    owned = Number(rows[0]?.n ?? 0);
  } else {
    const rows = rowsOf<{ n: number | string }>(
      await tx.execute(
        sql`select count(distinct submission_id)::int as n from form_sensitive_answers where submission_id::text in ${list(unique)}
            and submission_id not in (select submission_id from form_sensitive_answers where person_id is distinct from ${personId})`,
      ),
    );
    owned = Number(rows[0]?.n ?? 0);
  }
  if (owned !== unique.length) throw new ForbiddenError("forbidden: subject_result submissions of another person");
}

/** The purpose rules of PL-22; throws before anything is decrypted. */
async function checkPurpose(ctx: Ctx, personId: string, purpose: SensitivePurpose, scope: SensitiveScope | undefined): Promise<void> {
  if (purpose === "staff_view") {
    if (!actorHasPermission(ctx.actor, "persons.sensitive_read")) throw new ForbiddenError("forbidden: persons.sensitive_read", "persons.sensitive_read");
    return;
  }
  if (purpose === "privacy_export") {
    if (ctx.actor.kind !== "system") throw new ForbiddenError("forbidden: privacy_export needs the system actor");
    return;
  }
  if (purpose === "subject_result") {
    if (ctx.actor.kind !== "system") throw new ForbiddenError("forbidden: subject_result needs the system actor");
    if (!scope?.submissionIds?.length) throw new ForbiddenError("forbidden: subject_result needs submissionIds");
    await assertOwnSubmissions(ctx.tx, personId, scope.submissionIds);
    return;
  }
  throw new ForbiddenError(`forbidden: unknown purpose ${String(purpose)}`);
}

const toText = (v: unknown): string => {
  if (typeof v !== "string") return String(v);
  try {
    const parsed = JSON.parse(v) as unknown;
    return typeof parsed === "string" ? parsed : v;
  } catch {
    return v;
  }
};

/**
 * The person's sensitive data for one purpose. `scope` narrows what is decrypted: `keys`
 * limits `fields`, `eventIds` limits `notes`, `submissionIds` limits `formAnswers`; a scope that
 * names only some parts returns the others empty. Without `scope` everything is read
 * (`staff_view` and `privacy_export` only).
 */
export async function readSensitive(ctx: Ctx, personId: string, purpose: SensitivePurpose, scope?: SensitiveScope): Promise<SensitiveBundle> {
  await checkPurpose(ctx, personId, purpose, scope);
  const tx = ctx.tx;
  const all = scope === undefined;
  const bundle: SensitiveBundle = { fields: {}, formAnswers: [], notes: [] };
  const readKeys: string[] = [];
  const readSubmissions = new Set<string>();
  const readEvents: string[] = [];

  if ((all || scope?.keys?.length) && (await tableExists(tx, "person_sensitive_fields"))) {
    const keyFilter = scope?.keys?.length ? sql` and key::text in ${list(scope.keys)}` : sql``;
    const rows = rowsOf<{ key: string; value_enc: Uint8Array; key_version: number }>(
      await tx.execute(sql`select key::text as key, value_enc, key_version from person_sensitive_fields where person_id = ${personId}${keyFilter} order by key`),
    );
    for (const r of rows) {
      bundle.fields[r.key as SensitiveFieldKey] = decryptSensitive(r.value_enc, Number(r.key_version), sensitiveAad.personField(personId, r.key));
      readKeys.push(r.key);
    }
  }

  if ((all || scope?.submissionIds?.length) && (await tableExists(tx, "form_sensitive_answers"))) {
    const subFilter = scope?.submissionIds?.length ? sql` and submission_id::text in ${list(scope.submissionIds)}` : sql``;
    const rows = rowsOf<{ submission_id: string; field_key: string; value_enc: Uint8Array; key_version: number }>(
      await tx.execute(
        sql`select submission_id::text as submission_id, field_key, value_enc, key_version from form_sensitive_answers where person_id = ${personId}${subFilter} order by submission_id, field_key`,
      ),
    );
    for (const r of rows) {
      const plain = decryptSensitive(r.value_enc, Number(r.key_version), sensitiveAad.formAnswer(r.submission_id, r.field_key));
      bundle.formAnswers.push({ submissionId: r.submission_id, fieldKey: r.field_key, value: toText(plain) });
      readSubmissions.add(r.submission_id);
    }
  }

  if (all || scope?.eventIds?.length) {
    const eventFilter = scope?.eventIds?.length ? sql` and id::text in ${list(scope.eventIds)}` : sql``;
    const rows = rowsOf<{ id: string; data: { body_enc?: string; key_version?: number } }>(
      await tx.execute(
        sql`select id::text as id, data from activity_events where person_id = ${personId} and is_sensitive${eventFilter} order by occurred_at, id`,
      ),
    );
    for (const r of rows) {
      if (!r.data?.body_enc) continue;
      const body = decryptSensitive(Buffer.from(r.data.body_enc, "base64"), Number(r.data.key_version ?? 1), sensitiveAad.note(personId));
      bundle.notes.push({ eventId: r.id, body });
      readEvents.push(r.id);
    }
  }

  await ctx.audit({
    action: "sensitive.read",
    entityType: "person",
    entityId: personId,
    personId,
    newValue: { purpose, field_keys: readKeys, submission_ids: [...readSubmissions], event_ids: readEvents },
  });
  return bundle;
}

// ---------------------------------------------------------------------------
// Re-encryption (PL-70, `security.rekey`)
// ---------------------------------------------------------------------------

/** The tables `security.rekey` walks, in order (the `SENSITIVE_COLUMNS` tables plus the two secret columns of `users`). */
export const REKEY_TABLES = ["person_sensitive_fields", "form_sensitive_answers", "activity_events", "users"] as const;
export type RekeyTable = (typeof REKEY_TABLES)[number];
export const REKEY_CHUNK = 500;

type Rekeyed = { rows: number; lastId: string | null; done: boolean };

/**
 * Re-encrypts up to 500 rows of one table whose key version is below `toVersion`, after
 * `afterId` (rows already at `toVersion` are skipped, so a second run changes nothing).
 */
export async function rekeyChunk(tx: DbOrTx, input: { toVersion: number; table: RekeyTable; afterId?: string }): Promise<Rekeyed> {
  if (!sensitiveKey(input.toVersion)) throw new PermanentError(`missing_key: SENSITIVE_DATA_KEY_V${input.toVersion}`);
  const v = input.toVersion;
  if (input.table !== "users" && !(await tableExists(tx, input.table))) return { rows: 0, lastId: null, done: true };
  const after = input.afterId ?? "";
  let ids: string[];

  if (input.table === "person_sensitive_fields") {
    const rows = rowsOf<{ id: string; person_id: string; key: string; value_enc: Uint8Array; key_version: number }>(
      await tx.execute(sql`select id::text as id, person_id::text as person_id, key::text as key, value_enc, key_version from person_sensitive_fields
        where key_version < ${v} and id::text > ${after} order by id::text limit ${REKEY_CHUNK}`),
    );
    for (const r of rows) {
      const aad = sensitiveAad.personField(r.person_id, r.key);
      const { valueEnc } = encryptSensitive(decryptSensitive(r.value_enc, Number(r.key_version), aad), aad, v);
      await tx.execute(sql`update person_sensitive_fields set value_enc = ${Buffer.from(valueEnc)}, key_version = ${v} where id::text = ${r.id}`);
    }
    ids = rows.map((r) => r.id);
  } else if (input.table === "form_sensitive_answers") {
    const rows = rowsOf<{ id: string; submission_id: string; field_key: string; value_enc: Uint8Array; key_version: number }>(
      await tx.execute(sql`select id::text as id, submission_id::text as submission_id, field_key, value_enc, key_version from form_sensitive_answers
        where key_version < ${v} and id::text > ${after} order by id::text limit ${REKEY_CHUNK}`),
    );
    for (const r of rows) {
      const aad = sensitiveAad.formAnswer(r.submission_id, r.field_key);
      const { valueEnc } = encryptSensitive(decryptSensitive(r.value_enc, Number(r.key_version), aad), aad, v);
      await tx.execute(sql`update form_sensitive_answers set value_enc = ${Buffer.from(valueEnc)}, key_version = ${v} where id::text = ${r.id}`);
    }
    ids = rows.map((r) => r.id);
  } else if (input.table === "activity_events") {
    const afterNum = input.afterId ? BigInt(input.afterId) : -1n;
    const rows = rowsOf<{ id: string; person_id: string; data: { body_enc: string; key_version: number } }>(
      await tx.execute(sql`select id::text as id, person_id::text as person_id, data from activity_events
        where is_sensitive and coalesce((data->>'key_version')::int, 1) < ${v} and id > ${afterNum.toString()}::bigint order by id limit ${REKEY_CHUNK}`),
    );
    if (rows.length) await tx.execute(sql`set local beam.allow_rewrite = 'on'`);
    for (const r of rows) {
      const aad = sensitiveAad.note(r.person_id);
      const body = decryptSensitive(Buffer.from(r.data.body_enc, "base64"), Number(r.data.key_version ?? 1), aad);
      const { valueEnc } = encryptSensitive(body, aad, v);
      const data = { body_enc: Buffer.from(valueEnc).toString("base64"), key_version: v };
      await tx.execute(sql`update activity_events set data = ${JSON.stringify(data)}::jsonb where id = ${r.id}::bigint`);
    }
    ids = rows.map((r) => r.id);
  } else {
    const rows = rowsOf<{ id: string; totp_secret_enc: Uint8Array | null; recovery_codes_enc: Uint8Array | null; secret_key_version: number | null }>(
      await tx.execute(sql`select id::text as id, totp_secret_enc, recovery_codes_enc, secret_key_version from users
        where (totp_secret_enc is not null or recovery_codes_enc is not null) and coalesce(secret_key_version, 1) < ${v} and id::text > ${after}
        order by id::text limit ${REKEY_CHUNK}`),
    );
    for (const r of rows) {
      const from = Number(r.secret_key_version ?? 1);
      const totp = r.totp_secret_enc
        ? encryptSensitive(decryptSensitive(r.totp_secret_enc, from, sensitiveAad.totpSecret(r.id)), sensitiveAad.totpSecret(r.id), v).valueEnc
        : null;
      const codes = r.recovery_codes_enc
        ? encryptSensitive(decryptSensitive(r.recovery_codes_enc, from, sensitiveAad.recoveryCodes(r.id)), sensitiveAad.recoveryCodes(r.id), v).valueEnc
        : null;
      await tx.execute(sql`update users set totp_secret_enc = ${totp ? Buffer.from(totp) : null}, recovery_codes_enc = ${codes ? Buffer.from(codes) : null},
        secret_key_version = ${v} where id::text = ${r.id}`);
    }
    ids = rows.map((r) => r.id);
  }
  return { rows: ids.length, lastId: ids.at(-1) ?? null, done: ids.length < REKEY_CHUNK };
}
