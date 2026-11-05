/**
 * forms back-office reads (forms spec section 4 "Queries"): the form list with its 30-day funnel,
 * the form overview, versions and their comparison, and tracked links (forms-P5); the submissions
 * list and detail, the CSV export rows, the funnel and conversion report and the staff-entry form
 * list (forms-P6); the import sources and their events (forms-P7). The pages call them after `requireStaff()` with the screen's permissions. Only
 * the submission detail and the export return answer values, and never a sensitive one (SE1, SE4).
 */
import type { DbOrTx } from "@beam/db";
import {
  activityEvents,
  emailMessages,
  formImportEvents,
  formImportSources,
  formLinks,
  forms,
  formSensitiveAnswers,
  formSubmissions,
  formVersions,
  persons,
  users,
  vFormCampaignAttribution,
  vFormFunnelDaily,
  vFormKpisDaily,
  type FormConsentSnapshotJson,
  type FormCtaWarningJson,
  type FormUtmJson,
} from "@beam/db/schema";
import {
  brusselsDay,
  findRange,
  type Field,
  type FormDefinition,
  type FormKind,
  type FormLinkChannel,
  type FormScoring,
  type FormStatus,
  type ImportMapping,
  type SubmissionStatus,
} from "@beam/core/forms";
import { MESSAGES, type Locale, type LocalizedText } from "@beam/core/i18n";
import { and, asc, desc, eq, gte, inArray, isNull, lt, or, sql, type Ctx, type SQL } from "@/lib/ctx";
import { rowsOf } from "@/lib/sensitive";
import { requirePartnerOrPermission } from "@/modules/platform/api";
import { diffVersions, type VersionDiff } from "./service/diff";
import { mappingOf, maskedImportUrl } from "./service/import";
import { answerText, type SubmissionExportRow } from "./service/export-csv";
import { trackedLinkUrl } from "./service/qr";
import { parseVersion } from "./service/versions";

export type FormListRow = {
  id: string;
  slug: string;
  kind: FormKind;
  name: LocalizedText;
  status: FormStatus;
  currentVersion: number | null;
  locales: Locale[];
  hasDraft: boolean;
  started30d: number;
  completed30d: number;
  /** completed / started over 30 days, null without starts. */
  completionRate: number | null;
  updatedAt: Date;
};

const DAY = 86_400_000;

/** Brussels day `YYYY-MM-DD` that is `days` before `now`. */
const dayBefore = (now: Date, days: number) => brusselsDay(new Date(now.getTime() - days * DAY));

/** `/admin/forms`: every form with its current version, draft flag and 30-day funnel. */
export async function listForms(db: DbOrTx, filter: { status?: FormStatus; kind?: FormKind; q?: string } = {}, now: Date = new Date()): Promise<FormListRow[]> {
  const where = [];
  if (filter.status) where.push(eq(forms.status, filter.status));
  if (filter.kind) where.push(eq(forms.kind, filter.kind));
  const q = filter.q?.trim();
  if (q) {
    const pattern = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    where.push(sql`(${forms.slug} ilike ${pattern} or ${forms.name}::text ilike ${pattern})`);
  }
  const rows = await db
    .select({ form: forms, version: formVersions.version, locales: formVersions.locales })
    .from(forms)
    .leftJoin(formVersions, eq(formVersions.id, forms.currentVersionId))
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(forms.updatedAt));
  if (!rows.length) return [];
  const ids = rows.map((r) => r.form.id);
  const [drafts, funnel] = await Promise.all([
    db
      .select({ formId: formVersions.formId, locales: formVersions.locales })
      .from(formVersions)
      .where(and(inArray(formVersions.formId, ids), isNull(formVersions.publishedAt))),
    db
      .select({ formId: vFormFunnelDaily.formId, started: sql<number>`coalesce(sum(${vFormFunnelDaily.started}), 0)::int`, completed: sql<number>`coalesce(sum(${vFormFunnelDaily.completed}), 0)::int` })
      .from(vFormFunnelDaily)
      .where(and(inArray(vFormFunnelDaily.formId, ids), gte(vFormFunnelDaily.dayOn, dayBefore(now, 29))))
      .groupBy(vFormFunnelDaily.formId),
  ]);
  const draftOf = new Map(drafts.map((d) => [d.formId, d.locales]));
  const funnelOf = new Map(funnel.map((f) => [f.formId, f]));
  return rows.map((r) => {
    const f = funnelOf.get(r.form.id);
    const started = Number(f?.started ?? 0);
    const completed = Number(f?.completed ?? 0);
    return {
      id: r.form.id,
      slug: r.form.slug,
      kind: r.form.kind,
      name: r.form.name,
      status: r.form.status,
      currentVersion: r.version ?? null,
      locales: (r.locales ?? draftOf.get(r.form.id) ?? []) as Locale[],
      hasDraft: draftOf.has(r.form.id),
      started30d: started,
      completed30d: completed,
      completionRate: started ? completed / started : null,
      updatedAt: r.form.updatedAt,
    };
  });
}

export type VersionSummary = {
  id: string;
  version: number;
  locales: Locale[];
  definitionHash: string;
  changeNote: string | null;
  publishedAt: Date | null;
  updatedAt: Date;
};

export type FormDetail = {
  id: string;
  slug: string;
  kind: FormKind;
  name: LocalizedText;
  description: string | null;
  status: FormStatus;
  archivedAt: Date | null;
  ctaWarnings: FormCtaWarningJson[];
  everPublished: boolean;
  current: VersionSummary | null;
  draft: VersionSummary | null;
  linkCount: number;
  /** Last 7 Brussels days, summed. */
  funnel7d: { views: number; started: number; engaged: number; completed: number; abandoned: number };
  importSource: { id: string; name: string; provider: string; isActive: boolean } | null;
};

const summary = (v: typeof formVersions.$inferSelect): VersionSummary => ({
  id: v.id,
  version: v.version,
  locales: v.locales as Locale[],
  definitionHash: v.definitionHash,
  changeNote: v.changeNote,
  publishedAt: v.publishedAt,
  updatedAt: v.updatedAt,
});

/** `/admin/forms/[formId]`: the overview; null for an unknown form. */
export async function getForm(db: DbOrTx, formId: string, now: Date = new Date()): Promise<FormDetail | null> {
  const [form] = await db.select().from(forms).where(eq(forms.id, formId));
  if (!form) return null;
  const versions = await db.select().from(formVersions).where(eq(formVersions.formId, formId)).orderBy(desc(formVersions.version));
  const current = versions.find((v) => v.id === form.currentVersionId) ?? null;
  const draft = versions.find((v) => !v.publishedAt) ?? null;
  const [[links], [funnel], [source]] = await Promise.all([
    db.select({ n: sql<number>`count(*)::int` }).from(formLinks).where(eq(formLinks.formId, formId)),
    db
      .select({
        views: sql<number>`coalesce(sum(${vFormFunnelDaily.views}), 0)::int`,
        started: sql<number>`coalesce(sum(${vFormFunnelDaily.started}), 0)::int`,
        engaged: sql<number>`coalesce(sum(${vFormFunnelDaily.engaged}), 0)::int`,
        completed: sql<number>`coalesce(sum(${vFormFunnelDaily.completed}), 0)::int`,
        abandoned: sql<number>`coalesce(sum(${vFormFunnelDaily.abandoned}), 0)::int`,
      })
      .from(vFormFunnelDaily)
      .where(and(eq(vFormFunnelDaily.formId, formId), gte(vFormFunnelDaily.dayOn, dayBefore(now, 6)))),
    db
      .select({ id: formImportSources.id, name: formImportSources.name, provider: formImportSources.provider, isActive: formImportSources.isActive })
      .from(formImportSources)
      .where(eq(formImportSources.formId, formId))
      .limit(1),
  ]);
  const n = (v: unknown) => Number(v ?? 0);
  return {
    id: form.id,
    slug: form.slug,
    kind: form.kind,
    name: form.name,
    description: form.description,
    status: form.status,
    archivedAt: form.archivedAt,
    ctaWarnings: form.ctaWarnings ?? [],
    everPublished: versions.some((v) => v.publishedAt),
    current: current ? summary(current) : null,
    draft: draft ? summary(draft) : null,
    linkCount: n(links?.n),
    funnel7d: { views: n(funnel?.views), started: n(funnel?.started), engaged: n(funnel?.engaged), completed: n(funnel?.completed), abandoned: n(funnel?.abandoned) },
    importSource: source ?? null,
  };
}

export type FormVersion = VersionSummary & { formId: string; definition: FormDefinition; scoring: FormScoring; sensitiveFieldKeys: string[] };

/** One version with its parsed definition and scoring; null when unknown. */
export async function getFormVersion(db: DbOrTx, versionId: string): Promise<FormVersion | null> {
  const [v] = await db.select().from(formVersions).where(eq(formVersions.id, versionId));
  if (!v) return null;
  const c = parseVersion(v);
  return { ...summary(v), formId: v.formId, definition: c.definition, scoring: c.scoring, sensitiveFieldKeys: v.sensitiveFieldKeys };
}

export type VersionRow = VersionSummary & { publishedByName: string | null; isCurrent: boolean; submissions: number };

/** `/admin/forms/[formId]/versions`: newest first, with publisher and submission count. */
export async function listVersions(db: DbOrTx, formId: string): Promise<VersionRow[]> {
  const [form] = await db.select({ currentVersionId: forms.currentVersionId }).from(forms).where(eq(forms.id, formId));
  if (!form) return [];
  const rows = await db
    .select({ v: formVersions, publisher: users.name, publisherEmail: users.email })
    .from(formVersions)
    .leftJoin(users, eq(users.id, formVersions.publishedByUserId))
    .where(eq(formVersions.formId, formId))
    .orderBy(desc(formVersions.version));
  const counts = await db
    .select({ versionId: formSubmissions.formVersionId, n: sql<number>`count(*)::int` })
    .from(formSubmissions)
    .where(eq(formSubmissions.formId, formId))
    .groupBy(formSubmissions.formVersionId);
  const countOf = new Map(counts.map((c) => [c.versionId, Number(c.n)]));
  return rows.map((r) => ({
    ...summary(r.v),
    publishedByName: r.publisher ?? r.publisherEmail ?? null,
    isCurrent: r.v.id === form.currentVersionId,
    submissions: countOf.get(r.v.id) ?? 0,
  }));
}

/**
 * The comparison of two versions of the same form (older first by version number); null when
 * either is unknown or they belong to different forms. Section 4 names it `diffVersions(db, a, b)`;
 * the pure comparison of two rows is `service/diff.ts` `diffVersions`.
 */
export async function diffFormVersions(db: DbOrTx, aId: string, bId: string): Promise<VersionDiff | null> {
  const rows = await db.select().from(formVersions).where(inArray(formVersions.id, [aId, bId]));
  const a = rows.find((r) => r.id === aId);
  const b = rows.find((r) => r.id === bId);
  if (!a || !b || a.formId !== b.formId) return null;
  return a.version <= b.version ? diffVersions(a, b) : diffVersions(b, a);
}

export type LinkRow = {
  id: string;
  key: string;
  name: string;
  channel: FormLinkChannel;
  utm: FormUtmJson;
  partnerCompanyId: string | null;
  isActive: boolean;
  url: string;
  starts: number;
  completions: number;
  createdAt: Date;
};

/** The locale a tracked link opens in: the first locale of the current version (else the draft), `nl-BE` otherwise. */
export async function linkLocale(db: DbOrTx, formId: string): Promise<Locale> {
  const [v] = await db
    .select({ locales: formVersions.locales })
    .from(formVersions)
    .innerJoin(forms, eq(forms.id, formVersions.formId))
    .where(eq(formVersions.formId, formId))
    .orderBy(sql`(${formVersions.id} = ${forms.currentVersionId}) desc`, desc(formVersions.version))
    .limit(1);
  return ((v?.locales?.[0] as Locale | undefined) ?? "nl-BE");
}

/** `/admin/forms/[formId]/links`: tracked links with their URL, starts and completions. */
export async function listLinks(db: DbOrTx, formId: string): Promise<LinkRow[]> {
  const [form] = await db.select({ slug: forms.slug }).from(forms).where(eq(forms.id, formId));
  if (!form) return [];
  const locale = await linkLocale(db, formId);
  const rows = await db.select().from(formLinks).where(eq(formLinks.formId, formId)).orderBy(asc(formLinks.createdAt));
  if (!rows.length) return [];
  const stats = await db
    .select({
      linkId: formSubmissions.linkId,
      starts: sql<number>`count(*)::int`,
      completions: sql<number>`count(*) filter (where ${formSubmissions.status} = 'completed')::int`,
    })
    .from(formSubmissions)
    .where(inArray(formSubmissions.linkId, rows.map((r) => r.id)))
    .groupBy(formSubmissions.linkId);
  const statOf = new Map(stats.map((s) => [s.linkId, s]));
  return rows.map((r) => ({
    id: r.id,
    key: r.key,
    name: r.name,
    channel: r.channel,
    utm: r.utm,
    partnerCompanyId: r.partnerCompanyId,
    isActive: r.isActive,
    url: trackedLinkUrl({ slug: form.slug, locale, key: r.key }),
    starts: Number(statOf.get(r.id)?.starts ?? 0),
    completions: Number(statOf.get(r.id)?.completions ?? 0),
    createdAt: r.createdAt,
  }));
}

/** One link with its form slug (the QR route); null when unknown or of another form. */
export async function getLink(db: DbOrTx, formId: string, linkId: string): Promise<{ key: string; slug: string; url: string } | null> {
  const [row] = await db
    .select({ key: formLinks.key, slug: forms.slug })
    .from(formLinks)
    .innerJoin(forms, eq(forms.id, formLinks.formId))
    .where(and(eq(formLinks.id, linkId), eq(formLinks.formId, formId)));
  if (!row) return null;
  return { ...row, url: trackedLinkUrl({ slug: row.slug, locale: await linkLocale(db, formId), key: row.key }) };
}

type Tree = { readonly [key: string]: string | Tree };

/**
 * Screen copy for the admin client components: every `forms.<group>.*` message of the given groups
 * as a flat map keyed relative to `forms.` (for example `builder.save`). Missing keys render as
 * `⟦forms.<key>⟧` on the client.
 */
export function screenLabels(locale: Locale, groups: readonly string[]): Record<string, string> {
  const root = (MESSAGES[locale]?.forms)?.forms as Tree | undefined;
  const out: Record<string, string> = {};
  const walk = (node: Tree, prefix: string) => {
    for (const [k, v] of Object.entries(node)) {
      if (typeof v === "string") out[`${prefix}${k}`] = v;
      else walk(v, `${prefix}${k}.`);
    }
  };
  for (const g of groups) {
    const node = root?.[g];
    if (node && typeof node !== "string") walk(node, `${g}.`);
  }
  return out;
}

/** The locale names shown on the locale tabs, in the staff locale. */
export function localeNames(locale: Locale): Record<Locale, string> {
  const l = screenLabels(locale, ["locale"]);
  return { "nl-BE": l["locale.nl-BE"] ?? "Nederlands", "fr-BE": l["locale.fr-BE"] ?? "Français", en: l["locale.en"] ?? "English" };
}

// ---------------------------------------------------------------------------
// Submissions (forms-P6): list, detail and export rows
// ---------------------------------------------------------------------------

export const SUBMISSIONS_PAGE_SIZE = 50;

export type SubmissionFilter = {
  formId: string;
  status?: SubmissionStatus;
  outcomeKey?: string;
  versionId?: string;
  source?: string;
  funnel?: string;
  /** Brussels days `YYYY-MM-DD` on `started_at`, both inclusive. */
  from?: string;
  to?: string;
  /** Matches the person's email or name. */
  q?: string;
  cursor?: string;
};

export type SubmissionRow = {
  id: string;
  startedAt: Date;
  completedAt: Date | null;
  status: SubmissionStatus;
  person: { id: string; name: string | null; email: string | null; erased: boolean } | null;
  outcomeKey: string | null;
  total: number | null;
  version: number;
  versionId: string;
  source: string;
  campaign: string | null;
  funnel: string;
  enteredByName: string | null;
};

export type Page<T> = { rows: T[]; nextCursor: string | null };

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const startedDay = sql`(${formSubmissions.startedAt} at time zone 'Europe/Brussels')::date`;

/** Keyset cursor `(started_at, id)`, newest first. */
export function encodeCursor(startedAt: Date, id: string): string {
  return Buffer.from(JSON.stringify([startedAt.toISOString(), id])).toString("base64url");
}

/** A malformed cursor decodes to null (the first page). */
function decodeCursor(cursor: string | undefined): { at: Date; id: string } | null {
  if (!cursor) return null;
  try {
    const [at, id] = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as [string, string];
    const d = new Date(at);
    if (Number.isNaN(d.getTime()) || !/^[0-9a-f-]{36}$/i.test(id)) return null;
    return { at: d, id };
  } catch {
    return null;
  }
}

function submissionWhere(f: SubmissionFilter): SQL {
  const where: SQL[] = [eq(formSubmissions.formId, f.formId)];
  if (f.status) where.push(eq(formSubmissions.status, f.status));
  if (f.outcomeKey) where.push(eq(formSubmissions.outcomeKey, f.outcomeKey));
  if (f.versionId) where.push(eq(formSubmissions.formVersionId, f.versionId));
  if (f.source) where.push(sql`${formSubmissions.source} = ${f.source}`);
  if (f.funnel) where.push(eq(formSubmissions.funnel, f.funnel));
  if (f.from && DAY_RE.test(f.from)) where.push(sql`${startedDay} >= ${f.from}::date`);
  if (f.to && DAY_RE.test(f.to)) where.push(sql`${startedDay} <= ${f.to}::date`);
  const q = f.q?.trim();
  if (q) {
    const pattern = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    where.push(sql`(${persons.email} ilike ${pattern} or concat_ws(' ', ${persons.firstName}, ${persons.lastName}) ilike ${pattern})`);
  }
  return and(...where)!;
}

const SUBMISSION_STATUSES: readonly string[] = ["started", "partial", "abandoned", "completed"];

/** The list filter from the query string (unknown or malformed values are dropped). */
export function parseSubmissionFilter(sp: Record<string, string | string[] | undefined>): Omit<SubmissionFilter, "formId"> {
  const one = (k: string, max = 100): string | undefined => {
    const v = sp[k];
    return typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined;
  };
  const day = (k: string) => {
    const v = one(k, 10);
    return v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined;
  };
  const status = one("status");
  const versionId = one("versionId", 36);
  const out: Omit<SubmissionFilter, "formId"> = {};
  if (status && SUBMISSION_STATUSES.includes(status)) out.status = status as SubmissionStatus;
  if (versionId && /^[0-9a-f-]{36}$/i.test(versionId)) out.versionId = versionId;
  for (const k of ["outcomeKey", "source", "funnel", "q"] as const) {
    const v = one(k);
    if (v) out[k] = v;
  }
  const from = day("from");
  const to = day("to");
  if (from) out.from = from;
  if (to) out.to = to;
  const cursor = one("cursor", 200);
  if (cursor) out.cursor = cursor;
  return out;
}

const fullName = (first: string | null | undefined, last: string | null | undefined): string | null => [first, last].filter(Boolean).join(" ") || null;

/** `/admin/forms/[formId]/submissions`: 50 per page, newest first, keyset paging (`forms.write` and `persons.read`). */
export async function listSubmissions(db: DbOrTx, filter: SubmissionFilter): Promise<Page<SubmissionRow>> {
  const where = [submissionWhere(filter)];
  const c = decodeCursor(filter.cursor);
  if (c) where.push(or(lt(formSubmissions.startedAt, c.at), and(eq(formSubmissions.startedAt, c.at), lt(formSubmissions.id, c.id)))!);
  const rows = await db
    .select({
      s: {
        id: formSubmissions.id,
        startedAt: formSubmissions.startedAt,
        completedAt: formSubmissions.completedAt,
        status: formSubmissions.status,
        personId: formSubmissions.personId,
        outcomeKey: formSubmissions.outcomeKey,
        score: formSubmissions.score,
        versionId: formSubmissions.formVersionId,
        source: formSubmissions.source,
        campaign: formSubmissions.campaign,
        funnel: formSubmissions.funnel,
      },
      version: formVersions.version,
      email: persons.email,
      firstName: persons.firstName,
      lastName: persons.lastName,
      erasedAt: persons.erasedAt,
      staff: users.name,
      staffEmail: users.email,
    })
    .from(formSubmissions)
    .innerJoin(formVersions, eq(formVersions.id, formSubmissions.formVersionId))
    .leftJoin(persons, eq(persons.id, formSubmissions.personId))
    .leftJoin(users, eq(users.id, formSubmissions.enteredByUserId))
    .where(and(...where))
    .orderBy(desc(formSubmissions.startedAt), desc(formSubmissions.id))
    .limit(SUBMISSIONS_PAGE_SIZE + 1);
  const page = rows.slice(0, SUBMISSIONS_PAGE_SIZE);
  const last = page[page.length - 1];
  return {
    rows: page.map((r) => ({
      id: r.s.id,
      startedAt: r.s.startedAt,
      completedAt: r.s.completedAt,
      status: r.s.status,
      person: r.s.personId ? { id: r.s.personId, name: fullName(r.firstName, r.lastName), email: r.email ?? null, erased: !!r.erasedAt } : null,
      outcomeKey: r.s.outcomeKey,
      total: r.s.score?.total ?? null,
      version: r.version,
      versionId: r.s.versionId,
      source: r.s.source,
      campaign: r.s.campaign,
      funnel: r.s.funnel,
      enteredByName: r.staff ?? r.staffEmail ?? null,
    })),
    nextCursor: rows.length > SUBMISSIONS_PAGE_SIZE && last ? encodeCursor(last.s.startedAt, last.s.id) : null,
  };
}

export type SubmissionFilterOptions = {
  versions: { id: string; version: number }[];
  outcomes: { key: string; label: LocalizedText }[];
  sources: string[];
  funnels: string[];
};

/** The values the filter bar offers: published versions, outcomes of every version, sources and funnels seen. */
export async function getSubmissionFilterOptions(db: DbOrTx, formId: string): Promise<SubmissionFilterOptions> {
  const versions = await db.select().from(formVersions).where(eq(formVersions.formId, formId)).orderBy(desc(formVersions.version));
  const outcomes = new Map<string, LocalizedText>();
  for (const v of versions) for (const o of parseVersion(v).scoring.outcomes) if (!outcomes.has(o.key)) outcomes.set(o.key, o.label);
  const seen = await db.selectDistinct({ source: formSubmissions.source, funnel: formSubmissions.funnel }).from(formSubmissions).where(eq(formSubmissions.formId, formId));
  return {
    versions: versions.filter((v) => v.publishedAt).map((v) => ({ id: v.id, version: v.version })),
    outcomes: [...outcomes].map(([key, label]) => ({ key, label })),
    sources: [...new Set(seen.map((s) => s.source as string))].sort(),
    funnels: [...new Set(seen.map((s) => s.funnel))].sort(),
  };
}

/** The rows of the CSV export: every submission matching the filter (no cursor), newest first, at most 50,000. */
export async function listSubmissionsForExport(db: DbOrTx, filter: Omit<SubmissionFilter, "cursor">): Promise<SubmissionExportRow[]> {
  const rows = await db
    .select({
      s: formSubmissions,
      version: formVersions.version,
      email: persons.email,
      firstName: persons.firstName,
      lastName: persons.lastName,
      linkName: formLinks.name,
    })
    .from(formSubmissions)
    .innerJoin(formVersions, eq(formVersions.id, formSubmissions.formVersionId))
    .leftJoin(persons, eq(persons.id, formSubmissions.personId))
    .leftJoin(formLinks, eq(formLinks.id, formSubmissions.linkId))
    .where(submissionWhere(filter))
    .orderBy(desc(formSubmissions.startedAt), desc(formSubmissions.id))
    .limit(50_000);
  return rows.map((r) => ({
    id: r.s.id,
    status: r.s.status,
    startedAt: r.s.startedAt,
    completedAt: r.s.completedAt,
    version: r.version,
    locale: r.s.locale,
    personEmail: r.email ?? null,
    personFirstName: r.firstName ?? null,
    personLastName: r.lastName ?? null,
    outcomeKey: r.s.outcomeKey,
    total: r.s.score?.total ?? null,
    source: r.s.source,
    campaign: r.s.campaign,
    funnel: r.s.funnel,
    utm: r.s.utm ?? {},
    landingPath: r.s.landingPath,
    linkName: r.linkName ?? null,
    enteredByStaff: r.s.identifiedBy === "staff",
    answers: (r.s.answers ?? {}),
  }));
}

export type AnswerView = { key: string; type: Field["type"]; label: string; value: string | null; sensitive: boolean };

export type SubmissionDetail = {
  id: string;
  formId: string;
  formSlug: string;
  formName: LocalizedText;
  status: SubmissionStatus;
  locale: Locale;
  version: { id: string; version: number };
  person: { id: string; name: string | null; email: string | null; erased: boolean } | null;
  startedAt: Date;
  completedAt: Date | null;
  abandonedAt: Date | null;
  /** Answers per visible section of the pinned version, labels in the staff locale; sensitive fields carry no value. */
  sections: { key: string; title: string | null; visited: boolean; answers: AnswerView[] }[];
  /** `hidden` and `utm` fields. */
  hiddenValues: AnswerView[];
  scored: boolean;
  total: number | null;
  totalRangeLabel: string | null;
  dimensions: { key: string; label: string; value: number | null; rangeLabel: string | null; sensitive: boolean }[];
  outcome: { key: string; label: string } | null;
  ending: { key: string; title: string | null; kind: string } | null;
  path: { key: string; title: string | null }[];
  consents: FormConsentSnapshotJson[];
  attribution: {
    source: string;
    campaign: string | null;
    funnel: string;
    utm: FormUtmJson;
    landingPath: string | null;
    referrerUrl: string | null;
    embedHost: string | null;
    linkName: string | null;
    enteredByName: string | null;
  };
  events: { id: string; kind: string; occurredAt: Date }[];
  resultEmail: { messageId: string; status: string } | null;
  resendCount: number;
  resultLink: { expiresAt: Date | null; expired: boolean } | null;
  /** Rows in `form_sensitive_answers` (never their values). */
  sensitiveCount: number;
  hasSensitive: boolean;
};

/** The `send.resend` key prefix of a submission's result email (rule: `form_result:<submission_id>:resend:<n>`). */
export const resendKeyPrefix = (submissionId: string): string => `form_result:${submissionId}:resend:`;

/** How many times the result email of a submission was resent (email rows with the resend key). */
export async function countResends(db: DbOrTx, submissionId: string): Promise<number> {
  const prefix = resendKeyPrefix(submissionId).replace(/[\\%_]/g, (c) => `\\${c}`);
  const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(emailMessages).where(sql`${emailMessages.idempotencyKey} like ${`${prefix}%`}`);
  return Number(r?.n ?? 0);
}

/**
 * `/admin/forms/[formId]/submissions/[submissionId]` (`forms.write` and `persons.read`): the
 * answers rendered against the pinned version (U6) in the staff locale, score, outcome, ending,
 * path, consent snapshot, attribution, form events and result email status. Sensitive answers
 * are only counted; the reveal action decrypts them (SE3). Null when unknown.
 */
export async function getSubmission(db: DbOrTx, submissionId: string, locale: Locale = "nl-BE", now: Date = new Date()): Promise<SubmissionDetail | null> {
  if (!/^[0-9a-f-]{36}$/i.test(submissionId)) return null;
  const [row] = await db
    .select({
      s: formSubmissions,
      v: formVersions,
      form: { slug: forms.slug, name: forms.name },
      email: persons.email,
      firstName: persons.firstName,
      lastName: persons.lastName,
      erasedAt: persons.erasedAt,
      linkName: formLinks.name,
      staff: users.name,
      staffEmail: users.email,
    })
    .from(formSubmissions)
    .innerJoin(formVersions, eq(formVersions.id, formSubmissions.formVersionId))
    .innerJoin(forms, eq(forms.id, formSubmissions.formId))
    .leftJoin(persons, eq(persons.id, formSubmissions.personId))
    .leftJoin(formLinks, eq(formLinks.id, formSubmissions.linkId))
    .leftJoin(users, eq(users.id, formSubmissions.enteredByUserId))
    .where(eq(formSubmissions.id, submissionId));
  if (!row) return null;
  const s = row.s;
  const { definition: def, scoring } = parseVersion(row.v);
  const tx = (t: LocalizedText | undefined): string | null => (t ? (t[locale] ?? null) : null);
  const answers = (s.answers ?? {});
  const sensitiveKeys = new Set(row.v.sensitiveFieldKeys);
  const view = (f: Field): AnswerView => {
    const sensitive = f.sensitive || sensitiveKeys.has(f.key);
    return { key: f.key, type: f.type, label: tx(f.label) ?? f.key, value: sensitive ? null : answerText(f, answers[f.key], locale), sensitive };
  };
  const visited = new Set(s.path ?? []);
  const sections = def.sections.map((sec) => ({
    key: sec.key,
    title: tx(sec.title),
    visited: visited.has(sec.key),
    answers: sec.fieldKeys.map((k) => def.fields[k]).filter((f): f is Field => !!f && f.type !== "hidden" && f.type !== "utm").map(view),
  }));
  const hiddenValues = Object.values(def.fields).filter((f) => f.type === "hidden" || f.type === "utm").map(view);
  const score = s.score;
  const dims = scoring.dimensions.map((d) => {
    const stored = score?.dimensions?.[d.key];
    const value = stored?.value ?? null;
    const range = stored ? findRange(d.ranges, value) : null;
    return { key: d.key, label: tx(d.label) ?? d.key, value, rangeLabel: range ? tx(range.label) : null, sensitive: !!score && !stored };
  });
  const total = score?.total ?? null;
  const totalRange = total !== null && scoring.total ? findRange(scoring.total.ranges, total) : null;
  const outcome = s.outcomeKey ? (scoring.outcomes.find((o) => o.key === s.outcomeKey) ?? null) : null;
  const ending = s.endingKey ? (def.endings.find((e) => e.key === s.endingKey) ?? null) : null;
  const [events, email, sensitive, resends] = await Promise.all([
    s.personId
      ? db
          .select({ id: activityEvents.id, kind: activityEvents.kind, occurredAt: activityEvents.occurredAt })
          .from(activityEvents)
          .where(and(eq(activityEvents.refType, "form_submission"), eq(activityEvents.refId, s.id)))
          .orderBy(asc(activityEvents.occurredAt))
      : Promise.resolve([]),
    s.resultEmailMessageId ? db.select({ id: emailMessages.id, status: emailMessages.status }).from(emailMessages).where(eq(emailMessages.id, s.resultEmailMessageId)) : Promise.resolve([]),
    db.select({ n: sql<number>`count(*)::int` }).from(formSensitiveAnswers).where(eq(formSensitiveAnswers.submissionId, s.id)),
    countResends(db, s.id),
  ]);
  const sensitiveCount = Number(sensitive[0]?.n ?? 0);
  return {
    id: s.id,
    formId: s.formId,
    formSlug: row.form.slug,
    formName: row.form.name,
    status: s.status,
    locale: s.locale as Locale,
    version: { id: row.v.id, version: row.v.version },
    person: s.personId ? { id: s.personId, name: fullName(row.firstName, row.lastName), email: row.email ?? null, erased: !!row.erasedAt } : null,
    startedAt: s.startedAt,
    completedAt: s.completedAt,
    abandonedAt: s.abandonedAt,
    sections,
    hiddenValues,
    scored: scoring.dimensions.length > 0 || !!scoring.total,
    total,
    totalRangeLabel: totalRange ? tx(totalRange.label) : null,
    dimensions: dims,
    outcome: outcome ? { key: outcome.key, label: tx(outcome.label) ?? outcome.key } : s.outcomeKey ? { key: s.outcomeKey, label: s.outcomeKey } : null,
    ending: ending ? { key: ending.key, title: tx(ending.title), kind: ending.kind } : null,
    path: (s.path ?? []).map((k) => ({ key: k, title: tx(def.sections.find((x) => x.key === k)?.title) })),
    consents: s.consentSnapshot ?? [],
    attribution: {
      source: s.source,
      campaign: s.campaign,
      funnel: s.funnel,
      utm: s.utm ?? {},
      landingPath: s.landingPath,
      referrerUrl: s.referrerUrl,
      embedHost: s.embedHost,
      linkName: row.linkName ?? null,
      enteredByName: s.enteredByUserId ? (row.staff ?? row.staffEmail ?? null) : null,
    },
    events: events.map((e) => ({ id: String(e.id), kind: e.kind, occurredAt: e.occurredAt })),
    resultEmail: email[0] ? { messageId: email[0].id, status: email[0].status } : null,
    resendCount: resends,
    resultLink: s.status === "completed" && s.resultTokenHash ? { expiresAt: s.resultTokenExpiresAt, expired: !!s.resultTokenExpiresAt && s.resultTokenExpiresAt.getTime() <= now.getTime() } : null,
    sensitiveCount,
    hasSensitive: sensitiveCount > 0,
  };
}

// ---------------------------------------------------------------------------
// Funnel and conversion report (forms-P6)
// ---------------------------------------------------------------------------

export const REPORT_GROUPS = ["day", "version", "source", "campaign", "funnel", "link"] as const;
export type ReportGroupBy = (typeof REPORT_GROUPS)[number];

export type ReportMetrics = {
  /** Page views; null for a grouping views cannot be attributed to (version, source, campaign, funnel). */
  views: number | null;
  started: number;
  engaged: number;
  completed: number;
  abandoned: number;
  /** completed / started; null without starts. */
  completionRate: number | null;
  /** Completed submissions linked to a person (the base of the conversions). */
  linked: number;
  booked: number;
  purchased: number;
  revenueCents: number;
};

export type FormReport = {
  from: string;
  to: string;
  groupBy: ReportGroupBy;
  totals: ReportMetrics & { views: number; bookingRate: number | null; purchaseRate: number | null };
  outcomes: { key: string | null; label: LocalizedText | null; count: number; share: number }[];
  /** One row per group value; `key` '' is "none" (no campaign, no link). `version` is set when grouping by version. */
  groups: (ReportMetrics & { key: string; label: string; version?: number })[];
};

const rate = (a: number, b: number): number | null => (b ? a / b : null);

/**
 * `getFormReport(db, { formId, from, to, groupBy })` (`reports.read` or `forms.write`): the funnel
 * (views, started, engaged, completed, abandoned), the completion rate (completed / started), the
 * outcome distribution of completed submissions, and conversions to a booking or a purchase
 * within 30 days of completion with their revenue (`v_form_conversions`), in total and per group.
 * The cohort is the submissions started on the Brussels days `from` to `to` (inclusive, as
 * `v_form_funnel_daily` counts them); views are the counted page views of those days.
 */
export async function getFormReport(db: DbOrTx, input: { formId: string; from: string; to: string; groupBy: ReportGroupBy }): Promise<FormReport> {
  const { formId, from, to, groupBy } = input;
  if (!DAY_RE.test(from) || !DAY_RE.test(to)) throw new TypeError("invalid_range");
  const day = sql`(s.started_at at time zone 'Europe/Brussels')::date`;
  const keyExpr: Record<ReportGroupBy, SQL> = {
    day: sql`to_char(${day}, 'YYYY-MM-DD')`,
    version: sql`s.form_version_id::text`,
    source: sql`s.source`,
    campaign: sql`coalesce(s.campaign, '')`,
    funnel: sql`s.funnel`,
    link: sql`coalesce(l.key, '')`,
  };
  type Agg = { k: string; started: number; engaged: number; completed: number; abandoned: number; linked: number; booked: number; purchased: number; revenue: string | number };
  const agg = rowsOf<Agg>(
    await db.execute(sql`
      select ${keyExpr[groupBy]} as k,
             count(*)::int as started,
             count(*) filter (where s.status in ('partial', 'completed') or s.path <> '{}')::int as engaged,
             count(*) filter (where s.status = 'completed')::int as completed,
             count(*) filter (where s.status = 'abandoned')::int as abandoned,
             count(c.submission_id)::int as linked,
             count(c.first_booking_at)::int as booked,
             count(c.first_paid_at)::int as purchased,
             coalesce(sum(c.revenue_30d_cents), 0)::bigint as revenue
      from form_submissions s
      left join v_form_conversions c on c.submission_id = s.id
      left join form_links l on l.id = s.link_id
      where s.form_id = ${formId} and ${day} >= ${from}::date and ${day} <= ${to}::date
      group by 1 order by 1`),
  );
  const viewKey: Partial<Record<ReportGroupBy, SQL>> = { day: sql`to_char(v.day_on, 'YYYY-MM-DD')`, link: sql`v.link_key` };
  const vk = viewKey[groupBy] ?? sql`''`;
  const viewRows = rowsOf<{ k: string; views: number }>(
    await db.execute(sql`
      select ${vk} as k, coalesce(sum(v.views), 0)::int as views from form_views_daily v
      where v.form_id = ${formId} and v.day_on >= ${from}::date and v.day_on <= ${to}::date group by 1`),
  );
  const viewsOf = new Map(viewRows.map((r) => [r.k, Number(r.views)]));
  const totalViews = viewRows.reduce((n, r) => n + Number(r.views), 0);

  const keys = new Set(agg.map((a) => a.k));
  if (groupBy === "day" || groupBy === "link") for (const k of viewsOf.keys()) keys.add(k);
  const aggOf = new Map(agg.map((a) => [a.k, a]));

  const labels = new Map<string, { label: string; version?: number }>();
  if (groupBy === "version") {
    const vs = await db.select({ id: formVersions.id, version: formVersions.version }).from(formVersions).where(eq(formVersions.formId, formId));
    for (const v of vs) labels.set(v.id, { label: String(v.version), version: v.version });
  }
  if (groupBy === "link") {
    const ls = await db.select({ key: formLinks.key, name: formLinks.name }).from(formLinks).where(eq(formLinks.formId, formId));
    for (const l of ls) labels.set(l.key, { label: l.name });
  }

  const metrics = (a: Agg | undefined, views: number | null): ReportMetrics => {
    const started = Number(a?.started ?? 0);
    const completed = Number(a?.completed ?? 0);
    return {
      views,
      started,
      engaged: Number(a?.engaged ?? 0),
      completed,
      abandoned: Number(a?.abandoned ?? 0),
      completionRate: rate(completed, started),
      linked: Number(a?.linked ?? 0),
      booked: Number(a?.booked ?? 0),
      purchased: Number(a?.purchased ?? 0),
      revenueCents: Number(a?.revenue ?? 0),
    };
  };
  const groups = [...keys]
    .sort((a, b) => (groupBy === "version" ? (labels.get(a)?.version ?? 0) - (labels.get(b)?.version ?? 0) : a.localeCompare(b)))
    .map((k) => {
      const l = labels.get(k);
      return {
        key: k,
        label: l?.label ?? k,
        ...(l?.version !== undefined ? { version: l.version } : {}),
        ...metrics(aggOf.get(k), groupBy === "day" || groupBy === "link" ? (viewsOf.get(k) ?? 0) : null),
      };
    });

  const sum = (f: (m: ReportMetrics) => number) => groups.reduce((n, g) => n + f(g), 0);
  const t = {
    views: totalViews,
    started: sum((g) => g.started),
    engaged: sum((g) => g.engaged),
    completed: sum((g) => g.completed),
    abandoned: sum((g) => g.abandoned),
    linked: sum((g) => g.linked),
    booked: sum((g) => g.booked),
    purchased: sum((g) => g.purchased),
    revenueCents: sum((g) => g.revenueCents),
  };

  const outcomeRows = rowsOf<{ k: string | null; n: number }>(
    await db.execute(sql`
      select s.outcome_key as k, count(*)::int as n from form_submissions s
      where s.form_id = ${formId} and s.status = 'completed' and ${day} >= ${from}::date and ${day} <= ${to}::date
      group by 1 order by 2 desc, 1`),
  );
  const outcomeLabels = new Map<string, LocalizedText>();
  const versions = await db.select().from(formVersions).where(eq(formVersions.formId, formId)).orderBy(desc(formVersions.version));
  for (const v of versions) for (const o of parseVersion(v).scoring.outcomes) if (!outcomeLabels.has(o.key)) outcomeLabels.set(o.key, o.label);

  return {
    from,
    to,
    groupBy,
    totals: { ...t, completionRate: rate(t.completed, t.started), bookingRate: rate(t.booked, t.linked), purchaseRate: rate(t.purchased, t.linked) },
    outcomes: outcomeRows.map((o) => ({ key: o.k, label: o.k ? (outcomeLabels.get(o.k) ?? null) : null, count: Number(o.n), share: t.completed ? Number(o.n) / t.completed : 0 })),
    groups,
  };
}

// ---------------------------------------------------------------------------
// Staff-assisted entry (forms-P6, rule ID10)
// ---------------------------------------------------------------------------

export type StaffEntryForm = { formId: string; slug: string; kind: FormKind; name: LocalizedText; locales: Locale[] };

/** `/admin/forms/enter`: published forms whose current version allows staff entry (`persons.write`). */
export async function listStaffEntryForms(db: DbOrTx): Promise<StaffEntryForm[]> {
  const rows = await db
    .select({ form: forms, v: formVersions })
    .from(forms)
    .innerJoin(formVersions, eq(formVersions.id, forms.currentVersionId))
    .where(eq(forms.status, "published"))
    .orderBy(asc(forms.slug));
  return rows.flatMap((r) => {
    const c = parseVersion(r.v);
    return c.definition.settings.staffEntryAllowed ? [{ formId: r.form.id, slug: r.form.slug, kind: r.form.kind, name: r.form.name, locales: c.locales }] : [];
  });
}

// ---------------------------------------------------------------------------
// Import stopgap (forms-P7): sources and their events (`forms.publish` screens)
// ---------------------------------------------------------------------------

export const IMPORT_EVENT_STATUSES = ["received", "processed", "skipped", "failed"] as const;
export type ImportEventStatus = (typeof IMPORT_EVENT_STATUSES)[number];
export type ImportCounts = Record<ImportEventStatus, number>;

export type ImportSourceRow = {
  id: string;
  key: string;
  provider: "scoreapp" | "typeform";
  name: string;
  formId: string;
  formSlug: string;
  isActive: boolean;
  lastReceivedAt: Date | null;
  counts: ImportCounts;
  createdAt: Date;
};

const emptyCounts = (): ImportCounts => ({ received: 0, processed: 0, skipped: 0, failed: 0 });

async function importCounts(db: DbOrTx, sourceIds: string[]): Promise<Map<string, ImportCounts>> {
  const out = new Map<string, ImportCounts>();
  if (!sourceIds.length) return out;
  const rows = await db
    .select({ sourceId: formImportEvents.sourceId, status: formImportEvents.status, n: sql<number>`count(*)::int` })
    .from(formImportEvents)
    .where(inArray(formImportEvents.sourceId, sourceIds))
    .groupBy(formImportEvents.sourceId, formImportEvents.status);
  for (const r of rows) {
    const c = out.get(r.sourceId) ?? emptyCounts();
    c[r.status] = Number(r.n);
    out.set(r.sourceId, c);
  }
  return out;
}

/** `/admin/forms/imports`: every source with its mirror form, last delivery and counts per status. */
export async function listImportSources(db: DbOrTx): Promise<ImportSourceRow[]> {
  const rows = await db
    .select({ s: formImportSources, slug: forms.slug })
    .from(formImportSources)
    .innerJoin(forms, eq(forms.id, formImportSources.formId))
    .orderBy(desc(formImportSources.isActive), desc(formImportSources.createdAt));
  const counts = await importCounts(db, rows.map((r) => r.s.id));
  return rows.map(({ s, slug }) => ({
    id: s.id,
    key: s.key,
    provider: s.provider,
    name: s.name,
    formId: s.formId,
    formSlug: slug,
    isActive: s.isActive,
    lastReceivedAt: s.lastReceivedAt,
    counts: counts.get(s.id) ?? emptyCounts(),
    createdAt: s.createdAt,
  }));
}

export type ImportSourceDetail = ImportSourceRow & { maskedUrl: string; mapping: ImportMapping | null };

/** `/admin/forms/imports/[sourceId]`: the source with its masked webhook URL and mapping (never the secret or its hash). */
export async function getImportSource(db: DbOrTx, sourceId: string): Promise<ImportSourceDetail | null> {
  const [row] = await db
    .select({ s: formImportSources, slug: forms.slug })
    .from(formImportSources)
    .innerJoin(forms, eq(forms.id, formImportSources.formId))
    .where(eq(formImportSources.id, sourceId));
  if (!row) return null;
  const counts = await importCounts(db, [row.s.id]);
  const s = row.s;
  return {
    id: s.id,
    key: s.key,
    provider: s.provider,
    name: s.name,
    formId: s.formId,
    formSlug: row.slug,
    isActive: s.isActive,
    lastReceivedAt: s.lastReceivedAt,
    counts: counts.get(s.id) ?? emptyCounts(),
    createdAt: s.createdAt,
    maskedUrl: maskedImportUrl(s.key),
    mapping: mappingOf(s),
  };
}

export const IMPORT_EVENTS_PAGE_SIZE = 50;

/** One row of the events table: no payload (person data), only status, reason and the submission link. */
export type ImportEventRow = {
  id: string;
  externalId: string;
  status: ImportEventStatus;
  error: string | null;
  submissionId: string | null;
  receivedAt: Date;
  processedAt: Date | null;
};

/** The events of a source, newest first, keyset-paged on `(received_at, id)`. */
export async function listImportEvents(db: DbOrTx, input: { sourceId: string; status?: ImportEventStatus; cursor?: string }): Promise<Page<ImportEventRow>> {
  const where: SQL[] = [eq(formImportEvents.sourceId, input.sourceId)];
  if (input.status && (IMPORT_EVENT_STATUSES as readonly string[]).includes(input.status)) where.push(eq(formImportEvents.status, input.status));
  const c = decodeCursor(input.cursor);
  if (c) {
    where.push(
      or(lt(formImportEvents.receivedAt, c.at), and(eq(formImportEvents.receivedAt, c.at), sql`${formImportEvents.id} < ${c.id}::uuid`))!,
    );
  }
  const rows = await db
    .select({
      id: formImportEvents.id,
      externalId: formImportEvents.externalId,
      status: formImportEvents.status,
      error: formImportEvents.error,
      submissionId: formImportEvents.submissionId,
      receivedAt: formImportEvents.receivedAt,
      processedAt: formImportEvents.processedAt,
    })
    .from(formImportEvents)
    .where(and(...where))
    .orderBy(desc(formImportEvents.receivedAt), desc(formImportEvents.id))
    .limit(IMPORT_EVENTS_PAGE_SIZE + 1);
  const more = rows.length > IMPORT_EVENTS_PAGE_SIZE;
  const page = more ? rows.slice(0, IMPORT_EVENTS_PAGE_SIZE) : rows;
  const last = page[page.length - 1];
  return { rows: page, nextCursor: more && last ? encodeCursor(last.receivedAt, last.id) : null };
}

// ---------------------------------------------------------------------------
// R3 (forms-P9): marketing KPIs, campaign attribution, partner and referral link counts
// ---------------------------------------------------------------------------

/** A Brussels day range, both days included (`YYYY-MM-DD`). */
export type DayRange = { from: string; to: string };

export type FormKpiCounts = { leads: number; completions: number; ctaClicks: number; conversions: number; bookings: number; purchases: number; revenue30dCents: number };
export type FormKpiDay = FormKpiCounts & { dayOn: string };
export type FormKpis = { days: FormKpiDay[]; totals: FormKpiCounts & { conversionRate: number | null } };

const ratio = (n: number, d: number): number | null => (d > 0 ? n / d : null);

/** `/admin/forms/attribution` and the marketing dashboard: `v_form_kpis_daily` over a range, with totals. */
export async function getFormKpis(db: DbOrTx, range: DayRange): Promise<FormKpis> {
  const v = vFormKpisDaily;
  const rows = await db
    .select()
    .from(v)
    .where(and(gte(v.dayOn, range.from), sql`${v.dayOn} <= ${range.to}`))
    .orderBy(asc(v.dayOn));
  const days: FormKpiDay[] = rows.map((r) => ({
    dayOn: r.dayOn,
    leads: Number(r.leads),
    completions: Number(r.completions),
    ctaClicks: Number(r.ctaClicks),
    conversions: Number(r.conversions),
    bookings: Number(r.bookings),
    purchases: Number(r.purchases),
    revenue30dCents: Number(r.revenue30dCents),
  }));
  const sum = (f: (d: FormKpiDay) => number) => days.reduce((s, d) => s + f(d), 0);
  const totals: FormKpiCounts = {
    leads: sum((d) => d.leads),
    completions: sum((d) => d.completions),
    ctaClicks: sum((d) => d.ctaClicks),
    conversions: sum((d) => d.conversions),
    bookings: sum((d) => d.bookings),
    purchases: sum((d) => d.purchases),
    revenue30dCents: sum((d) => d.revenue30dCents),
  };
  return { days, totals: { ...totals, conversionRate: ratio(totals.conversions, totals.completions) } };
}

export type CampaignAttributionCounts = { leads: number; completions: number; bookings: number; revenue30dCents: number; spendCents: number; costPerLeadCents: number | null };
export type CampaignAttributionRow = CampaignAttributionCounts & { utmCampaign: string | null };
export type CampaignAttribution = { rows: CampaignAttributionRow[]; totals: CampaignAttributionCounts };

/** Spend / leads in whole cents; null without leads or without spend. */
export const costPerLead = (spendCents: number, leads: number): number | null => (leads > 0 && spendCents > 0 ? Math.round(spendCents / leads) : null);

/**
 * Campaign attribution over a range (`v_form_campaign_attribution` summed per `utm_campaign`):
 * leads, completions, bookings, 30-day revenue and ad spend, cost per lead recomputed from the
 * sums. Ordered by leads, then spend, then name; the "no campaign" row (null) last.
 */
export async function getCampaignAttribution(db: DbOrTx, range: DayRange): Promise<CampaignAttribution> {
  const v = vFormCampaignAttribution;
  const rows = await db
    .select({
      utmCampaign: v.utmCampaign,
      leads: sql<number>`sum(${v.leads})::int`,
      completions: sql<number>`sum(${v.completions})::int`,
      bookings: sql<number>`sum(${v.bookings})::int`,
      revenue30dCents: sql<number>`sum(${v.revenue30dCents})::bigint`,
      spendCents: sql<number>`sum(${v.spendCents})::bigint`,
    })
    .from(v)
    .where(and(gte(v.dayOn, range.from), sql`${v.dayOn} <= ${range.to}`))
    .groupBy(v.utmCampaign);
  const out: CampaignAttributionRow[] = rows.map((r) => {
    const leads = Number(r.leads);
    const spendCents = Number(r.spendCents);
    return {
      utmCampaign: r.utmCampaign,
      leads,
      completions: Number(r.completions),
      bookings: Number(r.bookings),
      revenue30dCents: Number(r.revenue30dCents),
      spendCents,
      costPerLeadCents: costPerLead(spendCents, leads),
    };
  });
  out.sort((a, b) => {
    if ((a.utmCampaign === null) !== (b.utmCampaign === null)) return a.utmCampaign === null ? 1 : -1;
    return b.leads - a.leads || b.spendCents - a.spendCents || (a.utmCampaign ?? "").localeCompare(b.utmCampaign ?? "");
  });
  const sum = (f: (r: CampaignAttributionRow) => number) => out.reduce((s, r) => s + f(r), 0);
  const leads = sum((r) => r.leads);
  const spendCents = sum((r) => r.spendCents);
  return {
    rows: out,
    totals: {
      leads,
      completions: sum((r) => r.completions),
      bookings: sum((r) => r.bookings),
      revenue30dCents: sum((r) => r.revenue30dCents),
      spendCents,
      costPerLeadCents: costPerLead(spendCents, leads),
    },
  };
}

/**
 * One partner's tracked link with its counts (R3, `partner.own`): no person id, name or email, no
 * answer and no referrer; the partner sees only links carrying their `partner_company_id`.
 */
export type PartnerLinkCount = {
  linkId: string;
  formSlug: string;
  formName: LocalizedText;
  name: string;
  channel: FormLinkChannel;
  isActive: boolean;
  views: number;
  starts: number;
  completions: number;
};

/** The columns a partner may see, in display order. */
export const PARTNER_LINK_COLUMNS = ["linkId", "formSlug", "formName", "name", "channel", "isActive", "views", "starts", "completions"] as const satisfies readonly (keyof PartnerLinkCount)[];

/** A partner or referral link as staff see it on the attribution screen. */
export type AttributedLinkCount = PartnerLinkCount & { partnerCompanyId: string | null; partnerName: string | null; referrerPersonId: string | null };

/**
 * Partner and referral links with their views, starts and completions. `companyId` set: only that
 * company's links. Null: every link with a partner or a referrer. `range` (Brussels days) limits
 * the counts by view day, start day and completion day; without it they are all-time.
 */
export async function listAttributedLinkCounts(db: DbOrTx, input: { companyId: string | null; range?: DayRange }): Promise<AttributedLinkCount[]> {
  const scope = input.companyId ? sql`l.partner_company_id = ${input.companyId}::uuid` : sql`(l.partner_company_id is not null or l.referrer_person_id is not null)`;
  const r = input.range;
  const inRange = (col: SQL) => (r ? sql`${col} between ${r.from}::date and ${r.to}::date` : sql`true`);
  const started = inRange(sql`(s.started_at at time zone 'Europe/Brussels')::date`);
  const completed = inRange(sql`(s.completed_at at time zone 'Europe/Brussels')::date`);
  const viewed = inRange(sql`d.day_on`);
  const rows = rowsOf<{
    link_id: string;
    form_slug: string;
    form_name: LocalizedText;
    name: string;
    channel: FormLinkChannel;
    is_active: boolean;
    partner_company_id: string | null;
    partner_name: string | null;
    referrer_person_id: string | null;
    views: number | string;
    starts: number | string;
    completions: number | string;
  }>(
    await db.execute(sql`
      select l.id::text as link_id, f.slug as form_slug, f.name as form_name, l.name, l.channel::text as channel, l.is_active,
             l.partner_company_id::text as partner_company_id, c.name as partner_name, l.referrer_person_id::text as referrer_person_id,
             coalesce((select sum(d.views) from form_views_daily d where d.form_id = l.form_id and d.link_key = l.key and ${viewed}), 0)::int as views,
             (select count(*) from form_submissions s where s.link_id = l.id and ${started})::int as starts,
             (select count(*) from form_submissions s where s.link_id = l.id and s.status = 'completed' and ${completed})::int as completions
      from form_links l
      join forms f on f.id = l.form_id
      left join companies c on c.id = l.partner_company_id
      where ${scope}
      order by c.name nulls last, f.slug, l.name, l.id`),
  );
  return rows.map((x) => ({
    linkId: x.link_id,
    formSlug: x.form_slug,
    formName: x.form_name,
    name: x.name,
    channel: x.channel,
    isActive: x.is_active,
    views: Number(x.views),
    starts: Number(x.starts),
    completions: Number(x.completions),
    partnerCompanyId: x.partner_company_id,
    partnerName: x.partner_name,
    referrerPersonId: x.referrer_person_id,
  }));
}

/** Only the partner-safe columns of a link count (no company, no referrer). */
export function toPartnerLinkCount(row: AttributedLinkCount): PartnerLinkCount {
  return Object.fromEntries(PARTNER_LINK_COLUMNS.map((k) => [k, row[k]])) as PartnerLinkCount;
}

/**
 * The partner area (R3, `partner.own`): the counts of the caller's own company's links. The company
 * comes from platform's `requirePartnerOrPermission(ctx, 'forms.write')`: an external partner (or
 * a staff member with only `partner.own`) is scoped to their `partner_company_id`; staff with
 * `forms.write` see every partner link (referral-only links stay out). Anyone else gets
 * `ForbiddenError`.
 */
export async function partnerLinkCounts(ctx: Ctx, range?: DayRange): Promise<PartnerLinkCount[]> {
  const { companyId } = await requirePartnerOrPermission(ctx, "forms.write");
  const rows = await listAttributedLinkCounts(ctx.tx, { companyId, ...(range ? { range } : {}) });
  return rows.filter((r) => r.partnerCompanyId !== null).map(toPartnerLinkCount);
}

export type LandingConversionRow = { landingPath: string; utmCampaign: string | null; submissions: number; newPersons: number };

/**
 * `countLandingConversions` (site insights, R3): completed submissions with a landing path whose
 * `completed_at` is in `[from, to)`, per landing path and `utm_campaign` (trimmed, lower-cased),
 * and how many of them created their person: the person's acquisition names this form and crm
 * captured it between the submission's start and its completion (ID3 at submit or ID9 at a save).
 */
export async function countLandingConversions(db: DbOrTx, input: { from: Date; to: Date }): Promise<LandingConversionRow[]> {
  const rows = rowsOf<{ landing_path: string; utm_campaign: string | null; submissions: number | string; new_persons: number | string }>(
    await db.execute(sql`
      select fs.landing_path, nullif(lower(trim(fs.utm->>'campaign')), '') as utm_campaign,
             count(*)::int as submissions,
             (count(*) filter (where p.id is not null
               and p.acquisition->>'form_slug' = f.slug
               and p.acquisition->>'captured_at' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T'
               and (p.acquisition->>'captured_at')::timestamptz between fs.started_at and fs.completed_at))::int as new_persons
      from form_submissions fs
      join forms f on f.id = fs.form_id
      left join persons p on p.id = fs.person_id
      where fs.status = 'completed' and fs.landing_path is not null and fs.landing_path <> ''
        and fs.completed_at >= ${input.from.toISOString()}::timestamptz and fs.completed_at < ${input.to.toISOString()}::timestamptz
      group by 1, 2
      order by 3 desc, 1, 2 nulls first`),
  );
  return rows.map((r) => ({ landingPath: r.landing_path, utmCampaign: r.utm_campaign, submissions: Number(r.submissions), newPersons: Number(r.new_persons) }));
}
