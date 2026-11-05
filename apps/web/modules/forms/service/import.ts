/**
 * The ScoreApp and Typeform import stopgap (forms spec rules I1 to I5, forms-P7).
 *
 * - Sources (`form_import_sources`): a 12-character key in the URL path, the sha256 of a 32-byte
 *   secret (shown once), an `ImportMapping` (I2) and a mirror form of kind `assessment` whose
 *   published version mirrors the mapped fields (`createImportSource`).
 * - Receiving (I1): `receiveImport` checks the secret in constant time and the source's
 *   `is_active`, stores the raw body with `insert ... on conflict (source_id, external_id) do
 *   nothing` and enqueues `forms.process_import` only when the row is new.
 * - CSV backfill (I5): `ingestCsv` turns every row into an event with `external_id = sha256(row)`
 *   through the same job; a second upload of the same file only counts duplicates.
 * - Processing (I3, I4): `processImportEvent` creates one `completed` submission on the mirror
 *   form's current version (`identified_by = 'import'`, `source = 'import'`), links the person by
 *   email (ID3, ID4 for `email`), encrypts sensitive mapped answers into `form_sensitive_answers`
 *   only, records consents that are literally `true` with method `import`, applies outcome tags
 *   and writes `form.completed` (`via_import: true`) and `assessment.result_generated`. It never
 *   sends the result email. A payload without a valid email, an invalid mapping or a mirror form
 *   without a published version marks the event `skipped` with the reason.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { parse as parseCsv } from "csv-parse/sync";
import { z } from "zod";
import type { Tx } from "@beam/db";
import { formImportEvents, formImportSources, forms, formSubmissions, formVersions, jobs, type FormConsentSnapshotJson, type FormScoreJson } from "@beam/db/schema";
import {
  canonicalJson,
  defaultSettings,
  deriveFunnel,
  findRange,
  FormDefinition as FormDefinitionSchema,
  FormScoring as FormScoringSchema,
  ImportMapping as ImportMappingSchema,
  isScored,
  type AnswerValue,
  type Field,
  type FormConsentPurpose,
  type FormDefinition,
  type FormScoring,
  type ImportMapping,
  type Outcome,
} from "@beam/core/forms";
import { emailHash, normaliseEmail } from "@beam/core/crm";
import { LOCALES, type Locale, type LocalizedText } from "@beam/core/i18n";
import { and, ConflictError, eq, NotFoundError, sql, ValidationError, type Ctx } from "@/lib/ctx";
import { translator } from "@/lib/i18n";
import { applyTag, fillAcquisitionIfEmpty, findOrCreatePersonByEmail, getPersonPrefill, recordConsent, updatePersonFields } from "@/modules/crm/api";
import { resolvePath, setPath } from "./json-path";
import { storeSensitive } from "./sensitive";
import { appOrigin, hashToken } from "./tokens";
import { insertDraftVersion, parseVersion, publishFormVersion, type StaffCtx } from "./versions";

export const IMPORT_JOB_KIND = "forms.process_import" as const;
/** I5: upload limits. */
export const IMPORT_CSV_MAX_BYTES = 2 * 1024 * 1024;
export const IMPORT_CSV_MAX_ROWS = 5000;
/** The wording version of an imported consent (crm accepts `legacy-import` for method `import`). */
export const IMPORT_WORDING_VERSION = "legacy-import";

type SourceRow = typeof formImportSources.$inferSelect;
type EventRow = typeof formImportEvents.$inferSelect;

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

// ---------------------------------------------------------------------------
// Keys, secrets and URLs (I1)
// ---------------------------------------------------------------------------

const KEY_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** A 12-character `[a-z0-9]` source key (the path segment). */
export function newSourceKey(): string {
  const bytes = randomBytes(12);
  return Array.from(bytes, (b) => KEY_ALPHABET[b % KEY_ALPHABET.length]).join("");
}

/** A 32-byte URL secret, base64url. Only its sha256 is stored. */
export function newImportSecret(): string {
  return randomBytes(32).toString("base64url");
}

/** The webhook URL a provider posts to. */
export function importUrl(key: string, secret: string): string {
  return `${appOrigin()}/api/public/forms/import/${key}/${secret}`;
}

/** The webhook URL with the secret masked (the source page). */
export function maskedImportUrl(key: string): string {
  return `${appOrigin()}/api/public/forms/import/${key}/••••••••`;
}

/** I1: constant-time comparison of `sha256(secret)` with the stored hash. */
export function secretMatches(secret: string, tokenHash: string): boolean {
  const a = Buffer.from(hashToken(secret), "hex");
  const b = Buffer.from(tokenHash, "hex");
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

/** The mapping of a source, or `null` when the stored JSON no longer parses. */
export function mappingOf(source: Pick<SourceRow, "mapping">): ImportMapping | null {
  const r = ImportMappingSchema.safeParse(source.mapping);
  return r.success ? r.data : null;
}

// ---------------------------------------------------------------------------
// Receiving (I1) and CSV backfill (I5)
// ---------------------------------------------------------------------------

const scalar = (v: unknown): string | null => (typeof v === "string" ? v.trim() || null : typeof v === "number" && Number.isFinite(v) ? String(v) : null);

/** The external id of a payload: the mapped id, else the sha256 of its canonical JSON. */
export function externalIdOf(mapping: ImportMapping | null, payload: Record<string, unknown>): string {
  const mapped = mapping ? scalar(resolvePath(payload, mapping.externalId)) : null;
  return mapped ? mapped.slice(0, 200) : sha256(canonicalJson(payload));
}

function emailHashOf(mapping: ImportMapping | null, payload: Record<string, unknown>): string | null {
  const email = mapping ? normaliseEmail(scalar(resolvePath(payload, mapping.email))) : null;
  return email ? emailHash(email) : null;
}

/** Inserts one event (`on conflict do nothing`) and enqueues the job only for a new row. */
async function storeEvent(tx: Tx, ctx: Ctx, source: SourceRow, externalId: string, payload: Record<string, unknown>): Promise<string | null> {
  const mapping = mappingOf(source);
  const [row] = await tx
    .insert(formImportEvents)
    .values({ sourceId: source.id, externalId, payload, emailHash: emailHashOf(mapping, payload), receivedAt: ctx.now })
    .onConflictDoNothing({ target: [formImportEvents.sourceId, formImportEvents.externalId] })
    .returning({ id: formImportEvents.id });
  if (!row) return null;
  await ctx.enqueue({ kind: IMPORT_JOB_KIND, payload: { importEventId: row.id }, key: `form_import:${row.id}` });
  return row.id;
}

/**
 * I1: the source of `sourceKey` when `secret` matches and it is active; otherwise `NotFoundError`
 * (the route answers `404` and stores nothing).
 */
export async function authenticateSource(tx: Tx, sourceKey: string, secret: string): Promise<SourceRow> {
  if (!/^[a-z0-9]{12}$/.test(sourceKey) || !secret || secret.length > 200) throw new NotFoundError("import_source_not_found");
  const [source] = await tx.select().from(formImportSources).where(eq(formImportSources.key, sourceKey));
  if (!source || !secretMatches(secret, source.tokenHash) || !source.isActive) throw new NotFoundError("import_source_not_found");
  return source;
}

/** I1: stores one provider payload; `stored` is false for a duplicate delivery. */
export async function receiveImport(tx: Tx, ctx: Ctx, i: { sourceKey: string; secret: string; payload: unknown }): Promise<{ stored: boolean; eventId: string | null }> {
  const source = await authenticateSource(tx, i.sourceKey, i.secret);
  if (!isRecord(i.payload)) throw new ValidationError("validation", { body: "object_expected" });
  const eventId = await storeEvent(tx, ctx, source, externalIdOf(mappingOf(source), i.payload), i.payload);
  await tx.update(formImportSources).set({ lastReceivedAt: ctx.now, updatedAt: ctx.now }).where(eq(formImportSources.id, source.id));
  return { stored: !!eventId, eventId };
}

/**
 * I5: the rows of a CSV export as payloads. The header row names the columns; a header that is a
 * simple JsonPath (`lead.email`, `answers[0]`) is set at that path, so a CSV with the mapping's
 * paths as headers addresses like the webhook body; any other header becomes a snake_case key.
 * Cells `true` and `false` become booleans (so a consent column can be literally true), all
 * other cells stay strings; empty cells are left out.
 */
export function csvRows(csv: string): { row: Record<string, string>; payload: Record<string, unknown> }[] {
  if (Buffer.byteLength(csv, "utf8") > IMPORT_CSV_MAX_BYTES) throw new ValidationError("csv_too_large", { csv: "csv_too_large" });
  let records: Record<string, string>[];
  try {
    records = parseCsv<Record<string, string>>(csv, { columns: true, bom: true, skip_empty_lines: true, trim: true, relax_column_count: true });
  } catch {
    throw new ValidationError("csv_invalid", { csv: "csv_invalid" });
  }
  if (records.length > IMPORT_CSV_MAX_ROWS) throw new ValidationError("csv_too_many_rows", { csv: "csv_too_many_rows" });
  return records.map((row) => {
    const payload: Record<string, unknown> = {};
    for (const [header, raw] of Object.entries(row)) {
      if (raw === undefined || raw === "") continue;
      const value = raw === "true" ? true : raw === "false" ? false : raw;
      if (!setPath(payload, header, value)) {
        const key = header.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "column";
        payload[key] = value;
      }
    }
    return { row, payload };
  });
}

/** I5: one event per CSV row (`external_id = sha256(row)`), each processed by `forms.process_import`. */
export async function ingestCsv(tx: Tx, ctx: StaffCtx, sourceId: string, csv: string): Promise<{ inserted: number; duplicates: number }> {
  const [source] = await tx.select().from(formImportSources).where(eq(formImportSources.id, sourceId));
  if (!source) throw new NotFoundError("import_source_not_found");
  const rows = csvRows(csv);
  let inserted = 0;
  let duplicates = 0;
  for (const { row, payload } of rows) {
    if (!Object.keys(payload).length) continue;
    const id = await storeEvent(tx, ctx, source, sha256(canonicalJson(row)), payload);
    if (id) inserted++;
    else duplicates++;
  }
  return { inserted, duplicates };
}

// ---------------------------------------------------------------------------
// Processing (I3, I4)
// ---------------------------------------------------------------------------

/** A mapped value as an answer: scalars and arrays of scalars; anything else is dropped. */
function answerOf(v: unknown): AnswerValue | undefined {
  if (v === null || v === undefined) return undefined;
  if (typeof v === "string") return v.trim() === "" ? undefined : v.slice(0, 10_000);
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "boolean") return v;
  if (Array.isArray(v)) {
    const out = v.map((x) => (typeof x === "string" ? x : typeof x === "number" && Number.isFinite(x) ? String(x) : null)).filter((x): x is string => x !== null);
    return out.length ? out.slice(0, 100) : undefined;
  }
  return undefined;
}

/** `nl`, `nl-BE`, `nl_be`, `fr`, `en-GB` ... to a supported locale of the version, else its first locale. */
export function importLocale(raw: unknown, locales: readonly string[]): Locale {
  const allowed = locales.filter((l): l is Locale => (LOCALES as readonly string[]).includes(l));
  const fallback = allowed[0] ?? "nl-BE";
  if (typeof raw !== "string") return fallback;
  const lang = raw.trim().toLowerCase().slice(0, 2);
  const found = allowed.find((l) => l.slice(0, 2) === lang);
  return found ?? fallback;
}

function dateOf(raw: unknown, now: Date): Date {
  if (typeof raw !== "string" && typeof raw !== "number") return now;
  const d = new Date(typeof raw === "number" && raw < 1e12 ? raw * 1000 : raw);
  if (Number.isNaN(d.getTime()) || d.getTime() > now.getTime()) return now;
  return d;
}

const numberOf = (raw: unknown): number | null => {
  const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw.trim().replace(",", ".")) : NaN;
  return Number.isFinite(n) ? n : null;
};

/** I2: the outcome key of an external result through `outcomeMap`, else the value itself when it is a mirror outcome. */
export function outcomeKeyOf(mapping: ImportMapping, scoring: FormScoring, raw: unknown): Outcome | null {
  const value = scalar(raw);
  if (value === null) return null;
  const key = mapping.outcomeMap?.[value] ?? value;
  return scoring.outcomes.find((o) => o.key === key) ?? null;
}

async function skip(tx: Tx, ctx: Ctx, event: EventRow, reason: string, emailHashValue?: string | null): Promise<"skipped"> {
  await tx
    .update(formImportEvents)
    .set({ status: "skipped", error: reason, processedAt: ctx.now, updatedAt: ctx.now, ...(emailHashValue !== undefined ? { emailHash: emailHashValue } : {}) })
    .where(eq(formImportEvents.id, event.id));
  return "skipped";
}

type ProfilePatch = { firstName?: string; lastName?: string; phone?: string };

/**
 * I3 and I4: processes one received event (locked `for update`). A second run sees `processed`
 * (or `skipped`) and returns that status without writing; `reprocessImportEvent` sets an event
 * back to `received` first.
 */
export async function processImportEvent(tx: Tx, ctx: Ctx, eventId: string): Promise<"processed" | "skipped"> {
  const [event] = await tx.select().from(formImportEvents).where(eq(formImportEvents.id, eventId)).for("update");
  if (!event) throw new NotFoundError("import_event_not_found");
  if (event.status === "processed") return "processed";
  if (event.status !== "received") return "skipped";
  const [source] = await tx.select().from(formImportSources).where(eq(formImportSources.id, event.sourceId));
  if (!source) throw new NotFoundError("import_source_not_found");
  const mapping = mappingOf(source);
  if (!mapping) return skip(tx, ctx, event, "invalid_mapping");
  const payload = event.payload;

  // I4: no valid email, no submission.
  const email = normaliseEmail(scalar(resolvePath(payload, mapping.email)));
  if (!email) return skip(tx, ctx, event, "missing_email", null);
  const hash = emailHash(email);

  const [form] = await tx.select().from(forms).where(eq(forms.id, source.formId));
  if (!form?.currentVersionId) return skip(tx, ctx, event, "mirror_form_not_published", hash);
  const [versionRow] = await tx.select().from(formVersions).where(eq(formVersions.id, form.currentVersionId));
  if (!versionRow) return skip(tx, ctx, event, "mirror_form_not_published", hash);
  const { definition: def, scoring } = parseVersion(versionRow);

  // The same external result received twice (webhook and CSV) is one submission.
  const externalRef = scalar(resolvePath(payload, mapping.externalId))?.slice(0, 200) ?? null;
  if (externalRef) {
    const [dup] = await tx
      .select({ id: formSubmissions.id })
      .from(formSubmissions)
      .where(and(eq(formSubmissions.formId, form.id), eq(formSubmissions.externalRef, externalRef), eq(formSubmissions.status, "completed")))
      .limit(1);
    if (dup) return skip(tx, ctx, event, "duplicate_result", hash);
  }

  const completedAt = mapping.completedAt ? dateOf(resolvePath(payload, mapping.completedAt), ctx.now) : ctx.now;
  const locale = importLocale(mapping.locale ? resolvePath(payload, mapping.locale) : undefined, versionRow.locales);
  const funnel = deriveFunnel(def.settings.funnel, form.slug);

  // Answers: only keys of the mirror version; sensitive ones never reach `answers` (SE1).
  const sensitiveKeys = new Set([...mapping.sensitiveFieldKeys, ...versionRow.sensitiveFieldKeys]);
  const plain: Record<string, AnswerValue> = {};
  const sensitive: Record<string, unknown> = {};
  for (const [fieldKey, path] of Object.entries(mapping.answers)) {
    if (!def.fields[fieldKey]) continue;
    const v = answerOf(resolvePath(payload, path));
    if (v === undefined) continue;
    if (sensitiveKeys.has(fieldKey)) sensitive[fieldKey] = v;
    else plain[fieldKey] = v;
  }
  const emailKey = Object.values(def.fields).find((f) => f.mapsTo === "person.email")?.key;
  if (emailKey && !sensitiveKeys.has(emailKey)) plain[emailKey] = email;

  const text = (path: string | undefined, max: number): string | undefined => {
    const v = path ? scalar(resolvePath(payload, path)) : null;
    return v ? v.slice(0, max) : undefined;
  };
  const profile: ProfilePatch = {};
  const fn = text(mapping.firstName, 100);
  const ln = text(mapping.lastName, 100);
  const ph = text(mapping.phone, 40);
  if (fn) profile.firstName = fn;
  if (ln) profile.lastName = ln;
  if (ph) profile.phone = ph;

  // Score and outcome come from the external tool (the mirror form does not compute them).
  const total = mapping.score ? numberOf(resolvePath(payload, mapping.score)) : null;
  const outcome = mapping.outcome ? outcomeKeyOf(mapping, scoring, resolvePath(payload, mapping.outcome)) : null;
  const scored = isScored(scoring) || total !== null;
  const score: FormScoreJson | null = scored ? { total, totalRangeKey: total !== null && scoring.total ? (findRange(scoring.total.ranges, total)?.key ?? null) : null, dimensions: {} } : null;
  const ending = def.endings.find((e) => e.key === outcome?.endingKey) ?? def.endings[0];

  // ID3 and ID4 (`email` identification): find or create, fill the acquisition once, only empty fields.
  const acquisition = { source: "import" as const, funnel, form_slug: form.slug };
  const person = await findOrCreatePersonByEmail(tx, ctx, { email, locale, acquisition });
  const personId = person.personId;
  if (!person.created) await fillAcquisitionIfEmpty(tx, ctx, personId, acquisition);
  const before = await getPersonPrefill(tx, personId);
  const conflicts = (Object.entries(profile) as [keyof ProfilePatch, string][])
    .filter(([k, v]) => !person.created && before[k] !== null && before[k] !== "" && before[k] !== v)
    .map(([k]) => k);
  if (Object.keys(profile).length) await updatePersonFields(tx, ctx, personId, profile, { onlyEmpty: true });

  const [sub] = await tx
    .insert(formSubmissions)
    .values({
      formId: form.id,
      formVersionId: versionRow.id,
      personId,
      status: "completed",
      identifiedBy: "import",
      answers: plain,
      score,
      outcomeKey: outcome?.key ?? null,
      endingKey: ending?.key ?? null,
      path: def.sections.map((s) => s.key),
      source: "import",
      funnel,
      locale,
      importEventId: event.id,
      externalRef,
      startedAt: completedAt,
      lastActivityAt: completedAt,
      completedAt,
    })
    .onConflictDoNothing()
    .returning({ id: formSubmissions.id });
  if (!sub) throw new ConflictError("import_already_processed");
  const ref = { type: "form_submission", id: sub.id };
  await storeSensitive(tx, { submissionId: sub.id, personId, values: sensitive });

  // I3: a consent only when the payload value is literally `true`; crm keeps suppressions (never lifted by an import).
  const snapshot: FormConsentSnapshotJson[] = [];
  for (const [purpose, path] of Object.entries(mapping.consents ?? {}) as [FormConsentPurpose, string][]) {
    if (resolvePath(payload, path) !== true) continue;
    const r = await recordConsent(tx, ctx, {
      personId,
      purpose,
      status: "granted",
      method: "import",
      source: `form_import:${source.key}`,
      wordingVersion: IMPORT_WORDING_VERSION,
      lawfulBasis: "consent",
      recordedAt: completedAt,
      ref,
    });
    snapshot.push({
      purpose,
      granted: r.outcome === "recorded" || r.outcome === "unchanged",
      wordingVersion: IMPORT_WORDING_VERSION,
      fieldKey: `import:${purpose}`,
      ...(r.outcome === "skipped_minor" ? { skippedMinor: true } : {}),
    });
  }

  // A5: outcome tags of the mirror outcome.
  const applied: string[] = [];
  for (const tagKey of outcome?.tagKeys ?? []) {
    try {
      if ((await applyTag(tx, ctx, personId, tagKey, "form")).applied) applied.push(tagKey);
    } catch (e) {
      if (!(e instanceof NotFoundError)) throw e;
    }
  }
  await tx.update(formSubmissions).set({ consentSnapshot: snapshot, appliedTagKeys: applied }).where(eq(formSubmissions.id, sub.id));

  // E1 to E4: `form.completed` with `via_import`, and the result event; I4: never a result email.
  const base = {
    submission_id: sub.id,
    form_id: form.id,
    form_slug: form.slug,
    form_kind: form.kind,
    form_version_id: versionRow.id,
    version: versionRow.version,
    source: "import" as const,
    campaign: null,
    funnel,
    utm: {},
    link_key: null,
  };
  await ctx.recordEvent({
    kind: "form.completed",
    personId,
    occurredAt: completedAt,
    ref,
    isSensitive: false,
    dedupeKey: `form:${sub.id}:completed`,
    data: {
      ...base,
      outcome_key: outcome?.key ?? null,
      score: total,
      dimensions: {},
      ending_key: ending?.key ?? null,
      applied_tag_keys: applied,
      profile_conflicts: conflicts,
      via_import: true,
      entered_by_staff: false,
    },
  });
  if (scored) {
    await ctx.recordEvent({
      kind: "assessment.result_generated",
      personId,
      occurredAt: completedAt,
      ref,
      isSensitive: false,
      dedupeKey: `form:${sub.id}:result`,
      data: {
        submission_id: sub.id,
        form_slug: form.slug,
        form_kind: form.kind,
        form_version_id: versionRow.id,
        version: versionRow.version,
        outcome_key: outcome?.key ?? null,
        score: total,
        funnel,
        source: "import",
        result_email: "not_sent",
      },
    });
  }
  await tx
    .update(formImportEvents)
    .set({ status: "processed", error: null, submissionId: sub.id, emailHash: hash, processedAt: ctx.now, updatedAt: ctx.now })
    .where(eq(formImportEvents.id, event.id));
  return "processed";
}

/** The job's dead hook: the event becomes `failed` with a short reason (ids only, no payload). */
export async function markImportFailed(tx: Tx, ctx: Ctx, eventId: string, message: string): Promise<void> {
  await tx
    .update(formImportEvents)
    .set({ status: "failed", error: message.slice(0, 300), processedAt: ctx.now, updatedAt: ctx.now })
    .where(and(eq(formImportEvents.id, eventId), eq(formImportEvents.status, "received")));
}

/** Reprocess a `failed` or `skipped` event: back to `received`, a fresh job key per attempt. */
export async function reprocessImportEvent(tx: Tx, ctx: StaffCtx, eventId: string): Promise<{ jobId: string; sourceId: string }> {
  const [event] = await tx.select().from(formImportEvents).where(eq(formImportEvents.id, eventId)).for("update");
  if (!event) throw new NotFoundError("import_event_not_found");
  if (event.status !== "failed" && event.status !== "skipped") throw new ConflictError("import_event_not_reprocessable");
  const prefix = `form_import:${event.id}`;
  const [n] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(jobs)
    .where(sql`${jobs.idempotencyKey} = ${prefix} or ${jobs.idempotencyKey} like ${`${prefix}:reprocess:%`}`);
  await tx.update(formImportEvents).set({ status: "received", error: null, processedAt: null, updatedAt: ctx.now }).where(eq(formImportEvents.id, event.id));
  const job = await ctx.enqueue({ kind: IMPORT_JOB_KIND, payload: { importEventId: event.id }, key: `${prefix}:reprocess:${Number(n?.n ?? 0)}` });
  return { jobId: job.id, sourceId: event.sourceId };
}

// ---------------------------------------------------------------------------
// Sources: create, update, rotate (section 4 actions)
// ---------------------------------------------------------------------------

/** Field keys the mirror form adds itself (email, names, the sensitive consent). */
export const MIRROR_RESERVED_KEYS = ["email", "first_name", "last_name", "sensitive_consent"] as const;

/** A mirror outcome: an external result the mapping's `outcomeMap` points at. */
export const MirrorOutcome = z.object({ key: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/), label: z.string().trim().min(1).max(120), tagKeys: z.array(z.string().max(80)).max(10).default([]) }).strict();
export type MirrorOutcome = z.infer<typeof MirrorOutcome>;

export type CreateImportSourceInput = {
  provider: "scoreapp" | "typeform";
  name: string;
  mapping: ImportMapping;
  mirrorFields: Field[];
  outcomes?: MirrorOutcome[];
  locales?: Locale[];
};

const same = (locales: readonly Locale[], s: string): LocalizedText => Object.fromEntries(locales.map((l) => [l, s]));
const fromCatalogue = (locales: readonly Locale[], key: string): LocalizedText => Object.fromEntries(locales.map((l) => [l, translator(l)(key)]));

/**
 * The mirror version of a source: email (and names when mapped) with `mapsTo`, the mapped fields
 * (sensitive when listed in `sensitiveFieldKeys`), the `sensitive_processing` consent first when
 * any field is sensitive (P5), one thank-you ending and, for mapped outcomes, mirror outcomes
 * (never computed for imports: the outcome comes from `outcomeMap`). No result email.
 */
export function mirrorContent(i: CreateImportSourceInput): { definition: FormDefinition; scoring: FormScoring; locales: Locale[] } {
  const locales: Locale[] = i.locales?.length ? [...new Set(i.locales)] : [...LOCALES];
  const m = i.mapping;
  const sensitive = new Set(m.sensitiveFieldKeys);
  const fields: Record<string, Field> = {};
  const order: string[] = [];
  const add = (f: Field) => {
    if (fields[f.key]) throw new ValidationError("validation", { [`mirrorFields.${f.key}`]: "duplicate_key" });
    fields[f.key] = f;
    order.push(f.key);
  };
  for (const f of i.mirrorFields) if (sensitive.has(f.key) || f.sensitive) sensitive.add(f.key);
  if (sensitive.size) {
    add({ key: "sensitive_consent", type: "consent", purpose: "sensitive_processing", label: fromCatalogue(locales, "forms.imports.mirror.sensitive_label"), wording: fromCatalogue(locales, "forms.imports.mirror.sensitive_wording"), required: true, sensitive: false });
  }
  add({ key: "email", type: "email", label: fromCatalogue(locales, "forms.imports.mirror.email"), required: true, sensitive: false, mapsTo: "person.email" });
  if (m.firstName) add({ key: "first_name", type: "short_text", label: fromCatalogue(locales, "forms.imports.mirror.first_name"), required: false, sensitive: false, mapsTo: "person.first_name" });
  if (m.lastName) add({ key: "last_name", type: "short_text", label: fromCatalogue(locales, "forms.imports.mirror.last_name"), required: false, sensitive: false, mapsTo: "person.last_name" });
  for (const f of i.mirrorFields) {
    if ((MIRROR_RESERVED_KEYS as readonly string[]).includes(f.key)) throw new ValidationError("validation", { [`mirrorFields.${f.key}`]: "reserved_key" });
    // A mirror field never maps to the person: email and names are the mirror's own fields.
    const { mapsTo: _mapsTo, ...rest } = f;
    add({ ...rest, required: false, sensitive: sensitive.has(f.key) });
  }
  for (const key of Object.keys(m.answers)) if (!fields[key]) throw new ValidationError("validation", { [`mapping.answers.${key}`]: "unknown_field" });
  for (const key of m.sensitiveFieldKeys) if (!fields[key]) throw new ValidationError("validation", { [`mapping.sensitiveFieldKeys.${key}`]: "unknown_field" });

  const ending = { key: "thank_you", kind: "thank_you" as const, title: fromCatalogue(locales, "forms.imports.mirror.thanks_title"), body: fromCatalogue(locales, "forms.imports.mirror.thanks_body"), showScore: false, showDimensions: [], ctas: [] };
  const settings = { ...defaultSettings("assessment", fromCatalogue(locales, "forms.imports.mirror.submit")), sendResultEmail: false, skipKnownFields: false };
  const definition = FormDefinitionSchema.parse({ title: same(locales, i.name), settings, sections: [{ key: "s1", fieldKeys: order }], fields, logic: [], endings: [ending] });
  const outcomes: Outcome[] = (i.outcomes ?? []).map((o, n) => ({
    key: o.key,
    label: same(locales, o.label),
    priority: n + 1,
    when: { field: "email", op: "answered" },
    endingKey: "thank_you",
    tagKeys: o.tagKeys,
  }));
  const known = new Set(outcomes.map((o) => o.key));
  for (const [ext, key] of Object.entries(m.outcomeMap ?? {})) if (!known.has(key)) throw new ValidationError("validation", { [`mapping.outcomeMap.${ext}`]: "unknown_outcome" });
  const scoring = FormScoringSchema.parse({ dimensions: [], outcomes, ...(outcomes.length ? { defaultOutcomeKey: outcomes[0]!.key } : {}) });
  return { definition, scoring, locales };
}

const staffId = (ctx: Ctx): string => {
  if (ctx.actor.kind !== "staff") throw new ConflictError("staff_only");
  return ctx.actor.userId;
};

/**
 * Section 4 `createImportSource`: the mirror form `import-<key>` (kind `assessment`) with its
 * version 1 published in the same transaction (P1 to P7, the DPIA gate included), then the source
 * with the sha256 of a new secret. The URL with the secret is returned once.
 */
export async function createImportSource(tx: Tx, ctx: StaffCtx, i: CreateImportSourceInput): Promise<{ sourceId: string; formId: string; key: string; url: string }> {
  const userId = staffId(ctx);
  const mapping = ImportMappingSchema.parse(i.mapping);
  const content = mirrorContent({ ...i, mapping });
  for (let attempt = 0; attempt < 5; attempt++) {
    const key = newSourceKey();
    const slug = `import-${key}`;
    const [form] = await tx
      .insert(forms)
      .values({ slug, kind: "assessment", name: same(content.locales, i.name), description: `Mirror of the ${i.provider} import "${i.name}"`, status: "draft", createdByUserId: userId })
      .onConflictDoNothing({ target: forms.slug })
      .returning({ id: forms.id });
    if (!form) continue;
    const v = await insertDraftVersion(tx, { formId: form.id, version: 1, ...content, createdByUserId: userId, changeNote: "import mirror" });
    await publishFormVersion(tx, { formId: form.id, versionId: v.versionId, publishedByUserId: userId, changeNote: "import mirror", now: ctx.now });
    const secret = newImportSecret();
    const [source] = await tx
      .insert(formImportSources)
      .values({ key, provider: i.provider, name: i.name, formId: form.id, tokenHash: hashToken(secret), mapping: mapping, createdByUserId: userId })
      .onConflictDoNothing({ target: formImportSources.key })
      .returning({ id: formImportSources.id });
    if (!source) throw new ConflictError("import_key_collision");
    return { sourceId: source.id, formId: form.id, key, url: importUrl(key, secret) };
  }
  throw new ConflictError("import_key_collision");
}

/** Section 4 `updateImportSource`: name, mapping (answers must stay mirror fields) and `is_active`. */
export async function updateImportSource(
  tx: Tx,
  ctx: StaffCtx,
  i: { sourceId: string; name?: string; mapping?: ImportMapping; isActive?: boolean },
): Promise<{ old: Record<string, unknown>; changed: Record<string, unknown> }> {
  const [source] = await tx.select().from(formImportSources).where(eq(formImportSources.id, i.sourceId)).for("update");
  if (!source) throw new NotFoundError("import_source_not_found");
  const changed: Record<string, unknown> = {};
  if (i.name !== undefined && i.name !== source.name) changed.name = i.name;
  if (i.isActive !== undefined && i.isActive !== source.isActive) changed.isActive = i.isActive;
  if (i.mapping !== undefined) {
    const mapping = ImportMappingSchema.parse(i.mapping);
    const [form] = await tx.select({ v: forms.currentVersionId }).from(forms).where(eq(forms.id, source.formId));
    const [row] = form?.v ? await tx.select().from(formVersions).where(eq(formVersions.id, form.v)) : [];
    const def = row ? parseVersion(row).definition : null;
    for (const key of [...Object.keys(mapping.answers), ...mapping.sensitiveFieldKeys]) {
      if (!def?.fields[key]) throw new ValidationError("validation", { [`mapping.answers.${key}`]: "unknown_field" });
    }
    const sensitive = new Set(row?.sensitiveFieldKeys ?? []);
    for (const key of Object.keys(mapping.answers)) if (sensitive.has(key) && !mapping.sensitiveFieldKeys.includes(key)) mapping.sensitiveFieldKeys.push(key);
    changed.mapping = mapping;
  }
  const old = Object.fromEntries(Object.keys(changed).map((k) => [k, (source as Record<string, unknown>)[k]]));
  if (Object.keys(changed).length) await tx.update(formImportSources).set({ ...changed, updatedAt: ctx.now }).where(eq(formImportSources.id, source.id));
  return { old, changed };
}

/** Section 4 `rotateImportSecret`: a new secret; the old URL stops working at once. */
export async function rotateImportSecret(tx: Tx, ctx: StaffCtx, sourceId: string): Promise<{ url: string }> {
  const [source] = await tx.select().from(formImportSources).where(eq(formImportSources.id, sourceId)).for("update");
  if (!source) throw new NotFoundError("import_source_not_found");
  const secret = newImportSecret();
  await tx.update(formImportSources).set({ tokenHash: hashToken(secret), updatedAt: ctx.now }).where(eq(formImportSources.id, source.id));
  return { url: importUrl(source.key, secret) };
}
