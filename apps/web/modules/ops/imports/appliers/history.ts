/**
 * Applier for kind `history` (ops spec rules 47a, 47b, 49, 50): historical facts with no native
 * row (past visits, no-shows, purchases, webinar registrations and attendance of the old tools)
 * into the append-only `imported_history`, unique on `(source, kind, external_id)` so a re-import
 * adds nothing twice. Each new row writes one `ops.history_imported` activity event with the
 * original `occurred_at` and `dedupe_key = import:<source>:<kind>:<external_id>`; never a
 * `webinar.*`, booking or order event, so no automation, reminder or review request fires.
 *
 * Source `webinar_tool` follows webinar's V1 stopgap rules 1-7: the kind comes from the preset
 * (registrants or attendees of WebinarGeek or Zoom), `external_id` is
 * `<provider>:<external_webinar_id>:<first 16 hex of sha256(lower(email))>`, an attendee row also
 * writes the registration, and `data` holds `{ provider, external_webinar_id, title, starts_at,
 * mode, watched_minutes }`. A new person gets `acquisition = { source: 'webinar', campaign: <title> }`
 * and locale `nl-BE` unless the row has one; no consent or suppression is ever written.
 */
import type { Tx } from "@beam/db";
import { importedHistory } from "@beam/db/schema";
import { IMPORTED_HISTORY_KINDS, IMPORTED_PRODUCT_KINDS, type ImportedHistoryKind, type ImportMapping } from "@beam/core/ops";
import { and, eq } from "@/lib/ctx";
import type { JobCtx } from "@/lib/job-runner";
import {
  assertNotErased,
  cell,
  emailDigest16,
  parseCents,
  parseInstantCell,
  parseIntCell,
  presetOf,
  requireEmail,
  resolvePersonByEmail,
  RowError,
  type ImportRow,
  type RowOutcome,
} from "../apply";

/** Extra webinar targets the mapping accepts for `webinar_tool` history files (see `jobs.ts`). */
export const WEBINAR_EXTRA_TARGETS = ["mode", "watched_minutes"] as const;

const KIND_ALIASES: Record<string, ImportedHistoryKind> = {
  sale: "purchase",
  receipt: "purchase",
  order: "purchase",
  paid: "purchase",
  attended: "visit",
  confirmed: "visit",
  approved: "visit",
  completed: "visit",
  done: "visit",
  noshow: "no_show",
  "no-show": "no_show",
  "no show": "no_show",
  absent: "no_show",
  cancelled: "cancellation",
  canceled: "cancellation",
  cancel: "cancellation",
  event: "event_attendance",
  registration: "webinar_registration",
  registered: "webinar_registration",
  assessment: "assessment_result",
  email: "email_engagement",
};

export function historyKindOf(value: string | null): ImportedHistoryKind {
  const v = (value ?? "").trim().toLowerCase();
  if (!v) throw new RowError("missing_history_kind");
  if ((IMPORTED_HISTORY_KINDS as readonly string[]).includes(v)) return v as ImportedHistoryKind;
  const alias = KIND_ALIASES[v] ?? KIND_ALIASES[v.replace(/_/g, " ")];
  if (!alias) throw new RowError("invalid_history_kind");
  return alias;
}

type Fact = { kind: ImportedHistoryKind; externalId: string; data: Record<string, unknown> };

/** The facts of one row: one, or two for a webinar attendee (registration plus attendance). */
function factsOf(row: ImportRow, mapping: ImportMapping, email: string, occurredAt: Date): Fact[] {
  const preset = presetOf(mapping);
  const fmt = mapping.options.dateFormat;
  if (row.source === "webinar_tool") {
    const kind = preset?.historyKind === "webinar_registration" || preset?.historyKind === "webinar_attendance" ? preset.historyKind : historyKindOf(cell(row, "history_kind"));
    if (kind !== "webinar_registration" && kind !== "webinar_attendance") throw new RowError("invalid_history_kind");
    const webinarId = cell(row, "external_id");
    if (!webinarId) throw new RowError("missing_external_id");
    const provider = preset?.provider ?? "other";
    const startsAt = parseInstantCell(cell(row, "webinar_starts_at"), fmt);
    const watchedMinutes = parseIntCell(cell(row, "watched_minutes"), { min: 0 });
    const modeText = cell(row, "mode")?.toLowerCase() ?? null;
    const mode = modeText === "live" || modeText === "replay" ? modeText : startsAt && occurredAt.getTime() > startsAt.getTime() + 4 * 3_600_000 ? "replay" : "live";
    const externalId = `${provider}:${webinarId}:${emailDigest16(email)}`.slice(0, 300);
    const base = { provider, external_webinar_id: webinarId, title: cell(row, "webinar_title"), starts_at: startsAt?.toISOString() ?? null };
    const registration: Fact = { kind: "webinar_registration", externalId, data: base };
    if (kind === "webinar_registration") return [registration];
    return [registration, { kind: "webinar_attendance", externalId, data: { ...base, mode, watched_minutes: watchedMinutes } }];
  }
  const kind = preset?.historyKind && !cell(row, "history_kind") ? preset.historyKind : historyKindOf(cell(row, "history_kind"));
  const externalId = cell(row, "external_id");
  if (!externalId) throw new RowError("missing_external_id");
  const rawProductKind = cell(row, "product_kind")?.toLowerCase() ?? null;
  const data: Record<string, unknown> = {};
  for (const key of ["session_kind", "campaign", "webinar_title", "outcome_key"]) {
    const v = cell(row, key);
    if (v) data[key] = v.slice(0, 200);
  }
  if (rawProductKind && !(IMPORTED_PRODUCT_KINDS as readonly string[]).includes(rawProductKind)) data.category = rawProductKind.slice(0, 100);
  const webinarStartsAt = parseInstantCell(cell(row, "webinar_starts_at"), fmt);
  if (webinarStartsAt) data.webinar_starts_at = webinarStartsAt.toISOString();
  return [{ kind, externalId: externalId.slice(0, 300), data }];
}

export async function applyHistoryRow(tx: Tx, ctx: JobCtx, row: ImportRow, opts: { dryRun: boolean; mapping: ImportMapping }): Promise<RowOutcome> {
  // Webinar rule 2: a registrant or attendee without email is skipped, not an error.
  if (row.source === "webinar_tool" && !cell(row, "email")) return { status: "skipped", message: "missing_email", entityType: "history" };
  const email = requireEmail(row);
  await assertNotErased(tx, email);
  const occurredAt = parseInstantCell(cell(row, "occurred_at"), opts.mapping.options.dateFormat);
  if (!occurredAt) throw new RowError("invalid_date");
  const facts = factsOf(row, opts.mapping, email, occurredAt);
  const amountCents = parseCents(cell(row, "amount_cents"));
  const rawProductKind = cell(row, "product_kind")?.toLowerCase() ?? null;
  const productKind = rawProductKind && (IMPORTED_PRODUCT_KINDS as readonly string[]).includes(rawProductKind) ? rawProductKind : null;
  const description = cell(row, "description")?.slice(0, 500) ?? null;

  if (opts.dryRun) {
    let fresh = 0;
    for (const f of facts) {
      const [hit] = await tx
        .select({ id: importedHistory.id })
        .from(importedHistory)
        .where(and(eq(importedHistory.source, row.source), eq(importedHistory.kind, f.kind), eq(importedHistory.externalId, f.externalId)))
        .limit(1);
      if (!hit) fresh += 1;
    }
    const { personId } = await resolvePersonByEmail(tx, ctx, row, email, { ...opts, webinarTitle: cell(row, "webinar_title") });
    return { status: fresh ? "imported" : "skipped", ...(fresh ? {} : { message: "existing" }), entityType: "history", ...(personId ? { personId } : {}) };
  }

  const { personId } = await resolvePersonByEmail(tx, ctx, row, email, { ...opts, webinarTitle: cell(row, "webinar_title") });
  let lastId: string | undefined;
  for (const f of facts) {
    const [inserted] = await tx
      .insert(importedHistory)
      .values({
        personId: personId!,
        importId: row.importId,
        source: row.source,
        kind: f.kind,
        occurredAt,
        externalId: f.externalId,
        description,
        amountCents: f.kind === "purchase" ? amountCents : null,
        productKind,
        data: f.data,
      })
      .onConflictDoNothing({ target: [importedHistory.source, importedHistory.kind, importedHistory.externalId] })
      .returning({ id: importedHistory.id });
    if (!inserted) continue;
    lastId = inserted.id;
    await ctx.recordEvent({
      kind: "ops.history_imported",
      personId: personId!,
      occurredAt,
      data: { kind: f.kind, source: row.source, ...(f.kind === "purchase" && amountCents !== null ? { amount_cents: amountCents } : {}) },
      dedupeKey: `import:${row.source}:${f.kind}:${f.externalId}`,
      ref: { type: "imported_history", id: inserted.id },
    });
  }
  if (!lastId) return { status: "skipped", message: "existing", personId: personId!, entityType: "history" };
  return { status: "imported", personId: personId!, entityType: "history", entityId: lastId };
}
