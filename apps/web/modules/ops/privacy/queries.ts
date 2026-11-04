/**
 * ops queries, area `privacy` (ops spec 4.2; ops-P5): listPrivacyRequests, getPrivacyRequest,
 * getMyPrivacyRequests and the download lookup. Server-only reads; the admin pages call
 * `requireStaff({ permission })` and the portal page `requireCustomer(locale)` before them.
 * Lists paginate at 50 rows and select named columns only. The detail never returns personal
 * data beyond the person's display name for staff.
 */
import type { DbOrTx } from "@beam/db";
import { persons, privacyRequests } from "@beam/db/schema";
import type { PrivacyKind, PrivacyReport, PrivacyStatus } from "@beam/core/ops";
import { and, count, desc, eq, type SQL } from "drizzle-orm";
import { reportOf } from "./report";

export const PRIVACY_PAGE_SIZE = 50;

export type PrivacyListItem = {
  id: string;
  personId: string;
  personName: string | null;
  kind: PrivacyKind;
  status: PrivacyStatus;
  requestedBy: "customer" | "staff" | "system";
  dueOn: string;
  needsManualFollowup: boolean;
  createdAt: Date;
};

const personName = (first: string | null, last: string | null) => [first, last].filter(Boolean).join(" ") || null;

export async function listPrivacyRequests(
  db: DbOrTx,
  opts: { status?: PrivacyStatus; kind?: PrivacyKind; page?: number } = {},
): Promise<{ items: PrivacyListItem[]; total: number; page: number; pageSize: number }> {
  const p = Math.max(1, Math.floor(opts.page ?? 1));
  const filters: SQL[] = [];
  if (opts.status) filters.push(eq(privacyRequests.status, opts.status));
  if (opts.kind) filters.push(eq(privacyRequests.kind, opts.kind));
  const where = filters.length ? and(...filters) : undefined;
  const [rows, [total]] = await Promise.all([
    db
      .select({
        id: privacyRequests.id,
        personId: privacyRequests.personId,
        firstName: persons.firstName,
        lastName: persons.lastName,
        kind: privacyRequests.kind,
        status: privacyRequests.status,
        requestedBy: privacyRequests.requestedBy,
        dueOn: privacyRequests.dueOn,
        needsManualFollowup: privacyRequests.needsManualFollowup,
        createdAt: privacyRequests.createdAt,
      })
      .from(privacyRequests)
      .leftJoin(persons, eq(persons.id, privacyRequests.personId))
      .where(where)
      .orderBy(desc(privacyRequests.createdAt), desc(privacyRequests.id))
      .limit(PRIVACY_PAGE_SIZE)
      .offset((p - 1) * PRIVACY_PAGE_SIZE),
    db.select({ n: count() }).from(privacyRequests).where(where),
  ]);
  const items = rows.map(({ firstName, lastName, ...r }) => ({ ...r, personName: personName(firstName, lastName) }));
  return { items, total: Number(total?.n ?? 0), page: p, pageSize: PRIVACY_PAGE_SIZE };
}

export type PrivacyRequestDetail = PrivacyListItem & {
  verifiedAt: Date | null;
  verificationNote: string | null;
  scheduledForAt: Date | null;
  rectifyFields: string[];
  warnings: string[];
  runAttempt: number;
  report: PrivacyReport;
  hasExport: boolean;
  completedAt: Date | null;
  restricted: boolean;
};

export async function getPrivacyRequest(db: DbOrTx, id: string): Promise<PrivacyRequestDetail | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const [r] = await db
    .select({
      id: privacyRequests.id,
      personId: privacyRequests.personId,
      firstName: persons.firstName,
      lastName: persons.lastName,
      restrictedAt: persons.processingRestrictedAt,
      kind: privacyRequests.kind,
      status: privacyRequests.status,
      requestedBy: privacyRequests.requestedBy,
      dueOn: privacyRequests.dueOn,
      needsManualFollowup: privacyRequests.needsManualFollowup,
      createdAt: privacyRequests.createdAt,
      verifiedAt: privacyRequests.verifiedAt,
      verificationNote: privacyRequests.verificationNote,
      scheduledForAt: privacyRequests.scheduledForAt,
      rectifyFields: privacyRequests.rectifyFields,
      warnings: privacyRequests.warnings,
      runAttempt: privacyRequests.runAttempt,
      report: privacyRequests.report,
      fileId: privacyRequests.fileId,
      completedAt: privacyRequests.completedAt,
    })
    .from(privacyRequests)
    .leftJoin(persons, eq(persons.id, privacyRequests.personId))
    .where(eq(privacyRequests.id, id));
  if (!r) return null;
  const { firstName, lastName, restrictedAt, fileId, report, warnings, ...rest } = r;
  return {
    ...rest,
    personName: personName(firstName, lastName),
    warnings: [...(warnings ?? [])],
    report: reportOf(report),
    hasExport: !!fileId,
    restricted: !!restrictedAt,
  };
}

export type MyPrivacyRequest = { id: string; kind: PrivacyKind; status: PrivacyStatus; createdAt: Date; scheduledForAt: Date | null; rectifyFields: string[]; hasExport: boolean };

/** The signed-in customer's requests, newest first (the portal page). */
export async function getMyPrivacyRequests(db: DbOrTx, personId: string): Promise<MyPrivacyRequest[]> {
  const rows = await db
    .select({
      id: privacyRequests.id,
      kind: privacyRequests.kind,
      status: privacyRequests.status,
      createdAt: privacyRequests.createdAt,
      scheduledForAt: privacyRequests.scheduledForAt,
      rectifyFields: privacyRequests.rectifyFields,
      fileId: privacyRequests.fileId,
    })
    .from(privacyRequests)
    .where(eq(privacyRequests.personId, personId))
    .orderBy(desc(privacyRequests.createdAt))
    .limit(PRIVACY_PAGE_SIZE);
  return rows.map(({ fileId, ...r }) => ({ ...r, hasExport: !!fileId }));
}

export type ExportDownload = { id: string; personId: string; status: PrivacyStatus; fileId: string | null; partFileIds: string[] };

/** The export request behind a download route; null for another kind. */
export async function getPrivacyExportForDownload(db: DbOrTx, id: string): Promise<ExportDownload | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const [r] = await db
    .select({ id: privacyRequests.id, kind: privacyRequests.kind, personId: privacyRequests.personId, status: privacyRequests.status, fileId: privacyRequests.fileId, partFileIds: privacyRequests.partFileIds })
    .from(privacyRequests)
    .where(eq(privacyRequests.id, id));
  if (!r || r.kind !== "export") return null;
  return { id: r.id, personId: r.personId, status: r.status, fileId: r.fileId, partFileIds: r.partFileIds };
}
