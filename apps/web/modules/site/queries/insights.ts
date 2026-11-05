/**
 * site queries, R3 landing-page insights (site spec section 5 `/admin/site/insights`; site-P9):
 * per landing path and UTM campaign, the form submissions and new persons (forms'
 * `countLandingConversions`) and the paid orders and revenue (commerce's `countOrdersByLanding`,
 * cross-module D56) in a period of Brussels days. Paths are matched to the live page holding
 * them, so a row names its page and kind. Reading needs `reports.read` and `site.edit`.
 */
import type { DbOrTx } from "@beam/db";
import { pageRoutes, pages, pageVersions } from "@beam/db/schema";
import { ForbiddenError } from "@beam/core/errors";
import { brusselsDay } from "@beam/core/crm";
import { localeFromSegment, type Locale, type LocalizedText } from "@beam/core/i18n";
import { brusselsMidnight } from "@beam/core/ops";
import type { PageKind } from "@beam/core/site";
import { actorHasPermission, and, eq, getAppDb, inArray, type Actor } from "@/lib/ctx";
import { countOrdersByLanding } from "@/modules/commerce/api";
import { countLandingConversions } from "@/modules/forms/api";

export type LandingInsightRow = {
  /** Normalised site path (`/nl/actie`), or null for orders without a landing path. */
  landingPath: string | null;
  utmCampaign: string | null;
  page: { pageId: string; kind: PageKind; slug: string; title: string } | null;
  submissions: number;
  newPersons: number;
  orders: number;
  revenueCents: number;
};

export type LandingInsights = {
  /** Brussels days, inclusive. */
  fromDay: string;
  toDay: string;
  rows: LandingInsightRow[];
  totals: { submissions: number; newPersons: number; orders: number; revenueCents: number };
};

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MAX_DAYS = 366;

const ymd = (day: string) => {
  const m = DAY_RE.exec(day)!;
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
};
const validDay = (day: string | undefined | null): day is string => {
  if (!day || !DAY_RE.test(day)) return false;
  const d = new Date(`${day}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === day;
};
/** `day` plus `n` calendar days (noon UTC keeps DST out of it). */
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/**
 * The period of the screen: `from` and `to` as `YYYY-MM-DD` Brussels days (inclusive); without
 * valid values the last 30 days up to today. A reversed range is swapped and a range is at most
 * 366 days. Returns the Brussels-midnight instants `[from, to)` the cross-module counts take.
 */
export function insightsPeriod(input: { from?: string | null; to?: string | null }, now: Date = new Date()): { fromDay: string; toDay: string; from: Date; to: Date } {
  const today = brusselsDay(now);
  let toDay = validDay(input.to) ? input.to : today;
  let fromDay = validDay(input.from) ? input.from : addDays(toDay, -29);
  if (fromDay > toDay) [fromDay, toDay] = [toDay, fromDay];
  if (Date.parse(`${toDay}T12:00:00Z`) - Date.parse(`${fromDay}T12:00:00Z`) > (MAX_DAYS - 1) * 86_400_000) fromDay = addDays(toDay, -(MAX_DAYS - 1));
  return { fromDay, toDay, from: brusselsMidnight(ymd(fromDay)), to: brusselsMidnight(ymd(addDays(toDay, 1))) };
}

/** A landing path as a comparable site path: same-origin path only, no query, lower case, no trailing slash. */
export function normaliseLandingPath(value: string | null | undefined): string | null {
  if (!value) return null;
  let path = value.trim();
  if (/^https?:\/\//i.test(path)) {
    try {
      path = new URL(path).pathname;
    } catch {
      return null;
    }
  }
  path = (path.split(/[?#]/)[0] ?? "").toLowerCase().replace(/\/+$/, "");
  if (!path.startsWith("/")) path = `/${path}`;
  return path === "/" ? "/" : path || null;
}

const campaignKey = (c: string | null | undefined) => {
  const v = c?.trim().toLowerCase();
  return v ? v : null;
};

/** The live pages holding the given site paths (`/nl/actie`), by path. */
async function pagesByPath(db: DbOrTx, paths: string[]): Promise<Map<string, NonNullable<LandingInsightRow["page"]>>> {
  const wanted = new Map<Locale, Set<string>>();
  for (const p of paths) {
    const [, seg, ...rest] = p.split("/");
    const locale = localeFromSegment(seg ?? "");
    if (!locale) continue;
    if (!wanted.has(locale)) wanted.set(locale, new Set());
    wanted.get(locale)!.add(rest.join("/"));
  }
  const out = new Map<string, NonNullable<LandingInsightRow["page"]>>();
  for (const [locale, set] of wanted) {
    const rows = await db
      .select({ path: pageRoutes.path, pageId: pages.id, kind: pages.kind, slug: pages.slug, title: pageVersions.title })
      .from(pageRoutes)
      .innerJoin(pages, eq(pages.id, pageRoutes.pageId))
      .innerJoin(pageVersions, eq(pageVersions.id, pageRoutes.versionId))
      .where(and(eq(pageRoutes.locale, locale), inArray(pageRoutes.path, [...set])));
    const seg = paths.find((p) => localeFromSegment(p.split("/")[1] ?? "") === locale)!.split("/")[1]!;
    for (const r of rows) {
      const title = (r.title as LocalizedText)[locale] ?? Object.values(r.title as LocalizedText)[0] ?? r.slug;
      out.set(r.path ? `/${seg}/${r.path}` : `/${seg}`, { pageId: r.pageId, kind: r.kind, slug: r.slug, title });
    }
  }
  return out;
}

/** The insights rows and totals of `[from, to)` (no permission check; the screen uses `getLandingInsightsFor`). */
export async function getLandingInsights(input: { from: Date; to: Date; fromDay?: string; toDay?: string }, db?: DbOrTx): Promise<LandingInsights> {
  const d = db ?? (await getAppDb());
  const [conversions, orders] = await Promise.all([countLandingConversions(d, { from: input.from, to: input.to }), countOrdersByLanding(d, { from: input.from, to: input.to })]);
  const rows = new Map<string, LandingInsightRow>();
  const rowOf = (landingPath: string | null, campaign: string | null) => {
    const path = normaliseLandingPath(landingPath);
    const utmCampaign = campaignKey(campaign);
    const key = `${path ?? ""}\u0000${utmCampaign ?? ""}`;
    let row = rows.get(key);
    if (!row) {
      row = { landingPath: path, utmCampaign, page: null, submissions: 0, newPersons: 0, orders: 0, revenueCents: 0 };
      rows.set(key, row);
    }
    return row;
  };
  for (const c of conversions) {
    const row = rowOf(c.landingPath, c.utmCampaign);
    row.submissions += Number(c.submissions) || 0;
    row.newPersons += Number(c.newPersons) || 0;
  }
  for (const o of orders) {
    const row = rowOf(o.landingPath, o.utmCampaign);
    row.orders += Number(o.orders) || 0;
    row.revenueCents += Number(o.revenueCents) || 0;
  }
  const list = [...rows.values()];
  const paths = [...new Set(list.flatMap((r) => (r.landingPath ? [r.landingPath] : [])))];
  const byPath = paths.length ? await pagesByPath(d, paths) : new Map();
  for (const r of list) r.page = r.landingPath ? (byPath.get(r.landingPath) ?? null) : null;
  list.sort(
    (a, b) =>
      b.revenueCents - a.revenueCents ||
      b.submissions - a.submissions ||
      (a.landingPath ?? "￿").localeCompare(b.landingPath ?? "￿") ||
      (a.utmCampaign ?? "").localeCompare(b.utmCampaign ?? ""),
  );
  const totals = list.reduce(
    (t, r) => ({ submissions: t.submissions + r.submissions, newPersons: t.newPersons + r.newPersons, orders: t.orders + r.orders, revenueCents: t.revenueCents + r.revenueCents }),
    { submissions: 0, newPersons: 0, orders: 0, revenueCents: 0 },
  );
  return { fromDay: input.fromDay ?? brusselsDay(input.from), toDay: input.toDay ?? brusselsDay(new Date(input.to.getTime() - 1)), rows: list, totals };
}

/** The insights screen's read: refuses an actor without `reports.read` and `site.edit` (site spec section 7). */
export async function getLandingInsightsFor(actor: Actor, input: { from?: string | null; to?: string | null }, opts: { db?: DbOrTx; now?: Date } = {}): Promise<LandingInsights> {
  if (!actorHasPermission(actor, "reports.read") || !actorHasPermission(actor, "site.edit")) throw new ForbiddenError("forbidden");
  const period = insightsPeriod(input, opts.now);
  return getLandingInsights(period, opts.db);
}

/** CSV of the insights (`;`-separated for Belgian spreadsheets, amounts in euros with a comma). */
export function insightsCsv(data: LandingInsights, headers: { landingPath: string; page: string; campaign: string; submissions: string; newPersons: string; orders: string; revenue: string }): string {
  const cell = (v: string | number | null) => {
    const s = v === null ? "" : String(v);
    const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
    return /[;"\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const euros = (cents: number) => (cents / 100).toFixed(2).replace(".", ",");
  const lines = [[headers.landingPath, headers.page, headers.campaign, headers.submissions, headers.newPersons, headers.orders, headers.revenue].map(cell).join(";")];
  for (const r of data.rows) lines.push([r.landingPath, r.page?.title ?? null, r.utmCampaign, r.submissions, r.newPersons, r.orders, euros(r.revenueCents)].map(cell).join(";"));
  return `${lines.join("\r\n")}\r\n`;
}
