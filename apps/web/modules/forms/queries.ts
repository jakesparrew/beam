/**
 * forms back-office reads (forms spec section 4 "Queries"; forms-P5): the form list with its 30-day
 * funnel, the form overview, versions and their comparison, and tracked links. The pages call
 * them after `requireStaff({ permission: 'forms.write' })`. No query returns an answer value.
 */
import type { DbOrTx } from "@beam/db";
import { formImportSources, formLinks, forms, formSubmissions, formVersions, users, vFormFunnelDaily, type FormCtaWarningJson, type FormUtmJson } from "@beam/db/schema";
import { brusselsDay, type FormDefinition, type FormKind, type FormLinkChannel, type FormScoring, type FormStatus } from "@beam/core/forms";
import { MESSAGES, type Locale, type LocalizedText } from "@beam/core/i18n";
import { and, asc, desc, eq, gte, inArray, isNull, sql } from "@/lib/ctx";
import { diffVersions, type VersionDiff } from "./service/diff";
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
