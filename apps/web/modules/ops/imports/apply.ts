/**
 * ops imports: the row contract and the helpers every applier shares (ops spec rules 42-51,
 * ops-P4). An applier turns one `import_rows` row into an outcome; `applyRow` runs it inside a
 * savepoint so a row error rolls back only that row and never aborts the chunk (rule 51). The
 * registry of appliers per kind lives in `jobs.ts` (no applier imports this file's caller).
 */
import { createHash } from "node:crypto";
import type { Tx } from "@beam/db";
import { importExternalIds, suppressions } from "@beam/db/schema";
import { emailHash, normaliseEmail, type Acquisition } from "@beam/core/crm";
import { isLocale, type Locale } from "@beam/core/i18n";
import { zonedTimeToUtc } from "@beam/core/platform";
import {
  IMPORT_PRESETS,
  type ExternalIdEntityType,
  type ImportEntityType,
  type ImportKind,
  type ImportMapping,
  type ImportPreset,
  type ImportPresetKey,
  type ImportRowStatus,
  type ImportSource,
} from "@beam/core/ops";
import { AppError, and, eq, sql } from "@/lib/ctx";
import type { JobCtx } from "@/lib/job-runner";
import { upsertPersonFromImport } from "@/modules/crm/api";
import { matchPerson } from "./match";

/** The mapped fields of one row (`import_rows.data`): target field to trimmed text. */
export type RowData = Record<string, string | null>;

/** One row as an applier sees it. */
export type ImportRow = {
  id: string;
  importId: string;
  importName: string;
  rowNumber: number;
  source: ImportSource;
  kind: ImportKind;
  data: RowData;
};

export type RowOutcome = {
  status: ImportRowStatus;
  message?: string;
  personId?: string;
  entityType?: ImportEntityType;
  entityId?: string;
};

/** The contract of every applier (ops-P4 exposes). */
export type RowApplier = (tx: Tx, ctx: JobCtx, row: ImportRow, opts: { dryRun: boolean; mapping: ImportMapping }) => Promise<RowOutcome>;

/** A row-level failure with a message code (`ops.imports.error.<code>`); never personal data. */
export class RowError extends Error {
  override readonly name = "RowError";
  constructor(readonly code: string) {
    super(code);
  }
}

/** Row codes that mean "skipped", not "error": an erased address is never brought back (rule 47a). */
export const SKIP_CODES: ReadonlySet<string> = new Set(["erased"]);

/** Message code of an in-file duplicate (rule 45), stored in `data.__dup_of` by the parse job. */
export const DUP_MARKER = "__dup_of";

// ---------------------------------------------------------------------------
// Running one row
// ---------------------------------------------------------------------------

/** A message code from an error: the text before the first `:` or space, at most 64 chars. */
export function errorCode(error: unknown): string | null {
  if (error instanceof RowError) return error.code;
  const pgCode = (error as { code?: unknown; cause?: { code?: unknown } } | null)?.code ?? (error as { cause?: { code?: unknown } } | null)?.cause?.code;
  if (typeof pgCode === "string" && /^2[23][0-9A-Z]{3}$/.test(pgCode)) return pgCode.startsWith("22") ? "invalid_value" : "constraint_violation";
  const isRowLevel =
    error instanceof AppError ||
    (error instanceof Error && (error as { retryable?: unknown }).retryable === false) ||
    (error instanceof Error && ["ValidationError", "NotFoundError", "ConflictError", "ForbiddenError", "PermanentError", "NotImplementedError"].includes(error.name));
  if (!isRowLevel) return null;
  const text = (error as Error).message.split(/[:\s]/)[0] ?? "";
  return (text.replace(/[^a-z0-9_]/gi, "").toLowerCase() || "error").slice(0, 64);
}

/**
 * Runs `applier` for `row` in a savepoint. A row-level error (`RowError`, an app or permanent
 * error, a data or constraint violation) rolls the savepoint back and returns `error` with its
 * code; any other error (a crash) propagates so the chunk retries and commits nothing.
 */
export async function applyRow(tx: Tx, ctx: JobCtx, row: ImportRow, opts: { dryRun: boolean; mapping: ImportMapping }, applier: RowApplier): Promise<RowOutcome> {
  const outer = ctx.tx;
  try {
    // `ctx.tx` points at the savepoint while the applier runs, so the events, jobs and audit rows
    // that other modules write through `ctx` roll back with the row (and never wait on a second
    // connection, which an in-process database would deadlock on).
    return await tx.transaction(async (sp) => {
      ctx.tx = sp as Tx;
      try {
        return await applier(sp as Tx, ctx, row, opts);
      } finally {
        ctx.tx = outer;
      }
    });
  } catch (error) {
    const code = errorCode(error);
    if (code === null) throw error;
    return { status: SKIP_CODES.has(code) ? "skipped" : "error", message: code };
  }
}

// ---------------------------------------------------------------------------
// Cells
// ---------------------------------------------------------------------------

/** The trimmed text of a mapped field, or null when empty. */
export function cell(row: ImportRow, key: string): string | null {
  const v = row.data[key];
  if (v === null || v === undefined) return null;
  const t = String(v).trim();
  return t ? t : null;
}

/** Rule 45 normalisation; `missing_email` / `invalid_email` otherwise. */
export function requireEmail(row: ImportRow, key = "email"): string {
  const raw = cell(row, key);
  if (!raw) throw new RowError("missing_email");
  const email = normaliseEmail(raw);
  if (!email) throw new RowError("invalid_email");
  return email;
}

/** The normalised email of an optional column; `invalid_email` for a malformed value. */
export function optionalEmail(row: ImportRow, key: string): string | null {
  const raw = cell(row, key);
  if (!raw) return null;
  const email = normaliseEmail(raw);
  if (!email) throw new RowError("invalid_email");
  return email;
}

export function parseIntCell(value: string | null, opts: { min?: number } = {}): number | null {
  if (value === null) return null;
  const s = value.replace(/\s/g, "");
  if (!/^[+-]?\d+$/.test(s)) throw new RowError("invalid_number");
  const n = Number(s);
  if (!Number.isSafeInteger(n) || (opts.min !== undefined && n < opts.min)) throw new RowError("invalid_number");
  return n;
}

/**
 * An amount in cents: a whole number is cents, a number with a decimal separator (`45,00`,
 * `45.5`, `1.234,50`) is euros, as the old tools export prices (runbook section 4).
 */
export function parseCents(value: string | null): number | null {
  if (value === null) return null;
  let s = value.replace(/[\s€]/g, "").replace(/^EUR/i, "");
  if (/^[+-]?\d+$/.test(s)) return parseIntCell(s);
  if (/^[+-]?\d{1,3}(\.\d{3})+,\d{1,2}$/.test(s)) s = s.replace(/\./g, "").replace(",", ".");
  else if (/^[+-]?\d{1,3}(,\d{3})+\.\d{1,2}$/.test(s)) s = s.replace(/,/g, "");
  else s = s.replace(",", ".");
  if (!/^[+-]?\d+(\.\d{1,2})?$/.test(s)) throw new RowError("invalid_number");
  return Math.round(Number(s) * 100);
}

type DateFormat = ImportMapping["options"]["dateFormat"];
type Parts = { year: number; month: number; day: number; hour: number; minute: number; second: number; zoned: Date | null };

function dateParts(value: string, format: DateFormat): Parts {
  const s = value.trim();
  if (format === "iso" || /^\d{4}-\d{2}-\d{2}/.test(s)) {
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?)?$/i.exec(s);
    if (!m) throw new RowError("invalid_date");
    const zoned = m[7] ? new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] ?? "00"}${m[7].length === 5 ? `${m[7].slice(0, 3)}:${m[7].slice(3)}` : m[7]}`) : null;
    return { year: +m[1]!, month: +m[2]!, day: +m[3]!, hour: m[4] ? +m[4] : 0, minute: m[5] ? +m[5] : 0, second: m[6] ? +m[6] : 0, zoned };
  }
  const m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?:[ T,]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AP]M)?)?$/i.exec(s);
  if (!m) throw new RowError("invalid_date");
  const [a, b] = [+m[1]!, +m[2]!];
  const day = format === "dd/mm/yyyy" ? a : b;
  const month = format === "dd/mm/yyyy" ? b : a;
  let hour = m[4] ? +m[4] : 0;
  if (m[7]) {
    if (hour < 1 || hour > 12) throw new RowError("invalid_date");
    hour = (hour % 12) + (m[7].toUpperCase() === "PM" ? 12 : 0);
  }
  return { year: +m[3]!, month, day, hour, minute: m[5] ? +m[5] : 0, second: m[6] ? +m[6] : 0, zoned: null };
}

function validParts(p: Parts): boolean {
  const t = new Date(Date.UTC(p.year, p.month - 1, p.day));
  return t.getUTCFullYear() === p.year && t.getUTCMonth() === p.month - 1 && t.getUTCDate() === p.day && p.hour < 24 && p.minute < 60 && p.second < 60;
}

/** A calendar date `YYYY-MM-DD` in the mapping's format. */
export function parseDateCell(value: string | null, format: DateFormat): string | null {
  if (value === null) return null;
  const p = dateParts(value, format);
  if (!validParts(p)) throw new RowError("invalid_date");
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** An instant; a wall-clock time without zone is Brussels time. */
export function parseInstantCell(value: string | null, format: DateFormat): Date | null {
  if (value === null) return null;
  const p = dateParts(value, format);
  if (!validParts(p)) throw new RowError("invalid_date");
  if (p.zoned) {
    if (Number.isNaN(p.zoned.getTime())) throw new RowError("invalid_date");
    return p.zoned;
  }
  const at = zonedTimeToUtc({ year: p.year, month: p.month, day: p.day, hour: p.hour, minute: p.minute });
  return new Date(at.getTime() + p.second * 1000);
}

/** The end of a Brussels calendar day (`23:59` local), for "expires on" and "period ends on" dates. */
export function endOfBrusselsDay(isoDate: string): Date {
  const [y, m, d] = isoDate.split("-").map(Number) as [number, number, number];
  return new Date(zonedTimeToUtc({ year: y, month: m, day: d, hour: 23, minute: 59 }).getTime() + 59_000);
}

/** Brussels midnight at the start of a calendar day. */
export function startOfBrusselsDay(isoDate: string): Date {
  const [y, m, d] = isoDate.split("-").map(Number) as [number, number, number];
  return zonedTimeToUtc({ year: y, month: m, day: d, hour: 0, minute: 0 });
}

/** `nl`, `NL-be`, `fr_BE`, `French`, `en` ... to a supported locale, else null. */
export function localeOf(value: string | null): Locale | null {
  if (!value) return null;
  const v = value.trim().toLowerCase().replace("_", "-");
  if (isLocale(value)) return value;
  if (v === "nl" || v === "nl-be" || v === "nl-nl" || v.startsWith("dutch") || v.startsWith("neder") || v.startsWith("vlaams")) return "nl-BE";
  if (v === "fr" || v === "fr-be" || v === "fr-fr" || v.startsWith("french") || v.startsWith("fran")) return "fr-BE";
  if (v === "en" || v.startsWith("en-") || v.startsWith("english") || v.startsWith("engels") || v.startsWith("anglais")) return "en";
  return null;
}

// ---------------------------------------------------------------------------
// Presets, persons, external ids
// ---------------------------------------------------------------------------

export function presetOf(mapping: ImportMapping): ImportPreset | null {
  const key = mapping.options.preset;
  if (!key || !(key in IMPORT_PRESETS)) return null;
  return IMPORT_PRESETS[key as ImportPresetKey];
}

/** Rule 47a: the address was erased (a `suppressions` row with reason `erased` on its hash). */
export async function isErasedEmail(tx: Tx, email: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: suppressions.id })
    .from(suppressions)
    .where(and(eq(suppressions.emailHash, emailHash(email)), eq(suppressions.reason, "erased")))
    .limit(1);
  return !!row;
}

/** Throws `RowError('erased')` for an erased address (rule 47a). */
export async function assertNotErased(tx: Tx, email: string | null): Promise<void> {
  if (email && (await isErasedEmail(tx, email))) throw new RowError("erased");
}

/** First 16 hex characters of sha256 of the normalised address (webinar external ids, rule 47a). */
export function emailDigest16(email: string): string {
  return createHash("sha256").update(email.trim().toLowerCase()).digest("hex").slice(0, 16);
}

/**
 * The acquisition of a person this import creates (rules 46 and 47a): `webinar` with the old
 * tool's webinar title for source `webinar_tool`, else `import` with the file's campaign or the
 * import name. `imported_created_at` keeps the original creation date of a persons file.
 */
export function newPersonAcquisition(row: ImportRow, extra: { webinarTitle?: string | null; createdAt?: string | null } = {}): Omit<Acquisition, "captured_at"> {
  if (row.source === "webinar_tool") return { source: "webinar", campaign: (extra.webinarTitle ?? row.importName).slice(0, 200) };
  const campaign = (cell(row, "source_campaign") ?? row.importName).slice(0, 200);
  const acquisition: Omit<Acquisition, "captured_at"> & { imported_created_at?: string } = { source: "import", campaign };
  if (extra.createdAt) acquisition.imported_created_at = extra.createdAt;
  return acquisition;
}

/** The locale of a new person: the row's when supported, else the option (webinar rows: `nl-BE`). */
export function newPersonLocale(row: ImportRow, mapping: ImportMapping): Locale {
  return localeOf(cell(row, "locale")) ?? (row.source === "webinar_tool" ? "nl-BE" : mapping.options.defaultLocale);
}

/**
 * The person of a non-persons row, by its email (rule 45): the matched person, or in a real run
 * a new one through crm's `upsertPersonFromImport` (every import resolves persons the same way).
 * In a dry run an unknown address gives `personId: null`.
 */
export async function resolvePersonByEmail(
  tx: Tx,
  ctx: JobCtx,
  row: ImportRow,
  email: string,
  opts: { dryRun: boolean; mapping: ImportMapping; webinarTitle?: string | null },
): Promise<{ personId: string | null; created: boolean }> {
  const match = await matchPerson(tx, { ...row, data: { email } });
  if (match.personId) return { personId: match.personId, created: false };
  if (opts.dryRun) return { personId: null, created: true };
  const { personId, outcome } = await upsertPersonFromImport(
    tx,
    ctx,
    { email, locale: newPersonLocale(row, opts.mapping), acquisition: newPersonAcquisition(row, { webinarTitle: opts.webinarTitle }) },
    row.importId,
  );
  return { personId, created: outcome === "created" };
}

/** Rule 50: one `import_external_ids` row per imported entity whose file has an external id. */
export async function writeExternalId(tx: Tx, row: ImportRow, entityType: ExternalIdEntityType, entityId: string, externalId: string | null = cell(row, "external_id")): Promise<void> {
  if (!externalId) return;
  await tx
    .insert(importExternalIds)
    .values({ source: row.source, entityType, externalId: externalId.slice(0, 200), entityId, importId: row.importId })
    .onConflictDoNothing({ target: [importExternalIds.source, importExternalIds.entityType, importExternalIds.externalId] });
}

/** An entity id stored for `(source, entity_type, external_id)`, or null. */
export async function externalEntityId(tx: Tx, source: ImportSource, entityType: ExternalIdEntityType, externalId: string | null): Promise<string | null> {
  if (!externalId) return null;
  const [row] = await tx
    .select({ entityId: importExternalIds.entityId })
    .from(importExternalIds)
    .where(and(eq(importExternalIds.source, source), eq(importExternalIds.entityType, entityType), eq(importExternalIds.externalId, externalId.slice(0, 200))))
    .limit(1);
  return row?.entityId ?? null;
}

/** The crm `persons.external_ids` key of a source (rule 50), or null when the id lives only in `import_external_ids`. */
export function crmExternalIdKey(source: ImportSource, mapping: ImportMapping): "simplybook" | "lightspeed" | "mailchimp" | "sheet" | "webinargeek" | "typeform" | "scoreapp" | null {
  const preset = presetOf(mapping);
  switch (source) {
    case "simplybook":
    case "lightspeed":
    case "mailchimp":
      return source;
    case "spreadsheet":
      return "sheet";
    case "webinar_tool":
      return preset?.externalIdKey === "webinargeek" ? "webinargeek" : null;
    case "assessment_tool":
      return preset?.externalIdKey === "typeform" || preset?.externalIdKey === "scoreapp" ? preset.externalIdKey : null;
    default:
      return null;
  }
}

/** `sql` re-exported for appliers that read other modules' tables directly (ops spec 2.3). */
export { sql };
