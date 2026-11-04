/**
 * webinar queries (webinar spec 4.3; webinar-P2): the staff list with its tabs, one webinar with
 * its polls, CTAs, presenters, series and broadcast job state, and the staff owner options.
 * Every function takes the caller's database or transaction first. Later packages add the
 * registrant list, the host console state and the reports.
 */
import { jobs, persons, users, watchSegments, webinarCtas, webinarInteractions, webinarPolls, webinarPresenters, webinarRegistrations, webinars } from "@beam/db/schema";
import type { WatchMode, WebinarMode, WebinarStatus } from "@beam/core/webinar";
import { and, asc, desc, eq, inArray, ne, or, sql, type DbOrTx, type SQL } from "@/lib/ctx";
import { jobKeys, type CtaRow, type PollRow, type PresenterRow, type WebinarRow } from "./server/lifecycle";

/** The tabs of `/admin/webinars` (section 5.1). */
export const WEBINAR_TABS = ["upcoming", "live", "ended", "on_demand", "drafts", "cancelled", "archived"] as const;
export type WebinarTab = (typeof WEBINAR_TABS)[number];

export const WEBINAR_PAGE_SIZE = 50;

const TAB_WHERE: Record<WebinarTab, SQL> = {
  upcoming: sql`${webinars.status} = 'published' and ${webinars.mode} <> 'on_demand'`,
  live: sql`${webinars.status} = 'live'`,
  ended: sql`${webinars.status} = 'ended'`,
  on_demand: sql`${webinars.status} = 'published' and ${webinars.mode} = 'on_demand'`,
  drafts: sql`${webinars.status} = 'draft'`,
  cancelled: sql`${webinars.status} = 'cancelled'`,
  archived: sql`${webinars.status} = 'archived'`,
};

export type WebinarListRow = {
  id: string;
  slug: string;
  title: WebinarRow["title"];
  mode: WebinarMode;
  status: WebinarStatus;
  startsAt: Date | null;
  publishRequestedAt: Date | null;
  broadcastError: string | null;
  registrations: number;
  liveAttendees: number;
  replayViewers: number;
};

const segmentViewers = (mode: WatchMode) =>
  sql<number>`(select count(distinct ${watchSegments.registrationId})::int from ${watchSegments} where ${watchSegments.webinarId} = ${webinars.id} and ${watchSegments.mode} = ${mode})`;

/**
 * One page of a tab, newest first for ended/cancelled/archived and soonest first otherwise.
 * `q` matches the slug or any title locale (case-insensitive).
 */
export async function listWebinars(
  db: DbOrTx,
  opts: { tab?: WebinarTab; status?: WebinarStatus; mode?: WebinarMode; q?: string; page?: number } = {},
): Promise<{ rows: WebinarListRow[]; hasMore: boolean }> {
  const tab = opts.tab ?? "upcoming";
  const page = Math.max(1, opts.page ?? 1);
  const where: SQL[] = [opts.status ? eq(webinars.status, opts.status) : TAB_WHERE[tab]];
  if (opts.mode) where.push(eq(webinars.mode, opts.mode));
  const q = opts.q?.trim();
  if (q) where.push(sql`(${webinars.slug} ilike ${`%${q}%`} or ${webinars.title}::text ilike ${`%${q}%`})`);
  const newestFirst = tab === "ended" || tab === "cancelled" || tab === "archived";
  const rows = await db
    .select({
      id: webinars.id,
      slug: webinars.slug,
      title: webinars.title,
      mode: webinars.mode,
      status: webinars.status,
      startsAt: webinars.startsAt,
      publishRequestedAt: webinars.publishRequestedAt,
      broadcastError: webinars.broadcastError,
      registrations: sql<number>`(select count(*)::int from ${webinarRegistrations} where ${webinarRegistrations.webinarId} = ${webinars.id} and ${webinarRegistrations.status} = 'registered')`,
      liveAttendees: segmentViewers("live"),
      replayViewers: segmentViewers("replay"),
    })
    .from(webinars)
    .where(and(...where))
    .orderBy(newestFirst ? sql`${webinars.startsAt} desc nulls last` : sql`${webinars.startsAt} asc nulls last`, desc(webinars.createdAt))
    .limit(WEBINAR_PAGE_SIZE + 1)
    .offset((page - 1) * WEBINAR_PAGE_SIZE);
  return {
    rows: rows.slice(0, WEBINAR_PAGE_SIZE).map((r) => ({ ...r, registrations: Number(r.registrations), liveAttendees: Number(r.liveAttendees), replayViewers: Number(r.replayViewers) })),
    hasMore: rows.length > WEBINAR_PAGE_SIZE,
  };
}

export type ModeCounts = Record<WatchMode, number>;
const emptyCounts = (): ModeCounts => ({ live: 0, replay: 0, on_demand: 0 });

export type PresenterView = PresenterRow & { email: string | null };
export type WebinarDetail = {
  webinar: WebinarRow;
  polls: Array<PollRow & { answers: ModeCounts }>;
  ctas: Array<CtaRow & { shown: ModeCounts; clicked: ModeCounts }>;
  presenters: PresenterView[];
  series: Array<{ id: string; slug: string; startsAt: Date | null; status: WebinarStatus }>;
  registrations: number;
  /** The latest `webinar.create_broadcast` job, for the "creating YouTube broadcast" state. */
  broadcastJob: { status: string; lastError: string | null; attempts: number } | null;
};

/** One webinar for the staff detail and interactive pages; null when unknown. */
export async function getWebinar(db: DbOrTx, webinarId: string): Promise<WebinarDetail | null> {
  const [webinar] = await db.select().from(webinars).where(eq(webinars.id, webinarId));
  if (!webinar) return null;
  const base = jobKeys.broadcast(webinar.id);
  const [polls, ctas, presenters, series, regs, broadcastJobs, counts] = await Promise.all([
    db.select().from(webinarPolls).where(eq(webinarPolls.webinarId, webinar.id)).orderBy(asc(webinarPolls.sortOrder), asc(webinarPolls.createdAt)),
    db.select().from(webinarCtas).where(eq(webinarCtas.webinarId, webinar.id)).orderBy(asc(webinarCtas.sortOrder), asc(webinarCtas.createdAt)),
    db
      .select({ presenter: webinarPresenters, userEmail: users.email, personEmail: persons.email })
      .from(webinarPresenters)
      .leftJoin(users, eq(users.id, webinarPresenters.userId))
      .leftJoin(persons, eq(persons.id, webinarPresenters.personId))
      .where(eq(webinarPresenters.webinarId, webinar.id))
      .orderBy(asc(webinarPresenters.sortOrder), asc(webinarPresenters.createdAt)),
    webinar.seriesKey
      ? db
          .select({ id: webinars.id, slug: webinars.slug, startsAt: webinars.startsAt, status: webinars.status })
          .from(webinars)
          .where(and(eq(webinars.seriesKey, webinar.seriesKey), ne(webinars.id, webinar.id)))
          .orderBy(sql`${webinars.startsAt} asc nulls last`)
      : Promise.resolve([]),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(webinarRegistrations)
      .where(and(eq(webinarRegistrations.webinarId, webinar.id), eq(webinarRegistrations.status, "registered"))),
    db
      .select({ status: jobs.status, lastError: jobs.lastError, attempts: jobs.attempts })
      .from(jobs)
      .where(or(eq(jobs.idempotencyKey, base), sql`${jobs.idempotencyKey} like ${`${base}:retry:%`}`))
      .orderBy(desc(jobs.createdAt))
      .limit(1),
    db
      .select({
        pollId: webinarInteractions.pollId,
        ctaId: webinarInteractions.ctaId,
        kind: webinarInteractions.kind,
        mode: webinarInteractions.mode,
        n: sql<number>`count(*)::int`,
      })
      .from(webinarInteractions)
      .where(and(eq(webinarInteractions.webinarId, webinar.id), inArray(webinarInteractions.kind, ["poll_answer", "cta_shown", "cta_clicked"])))
      .groupBy(webinarInteractions.pollId, webinarInteractions.ctaId, webinarInteractions.kind, webinarInteractions.mode),
  ]);
  const count = (id: string, kind: string) => {
    const out = emptyCounts();
    for (const c of counts) if ((c.pollId === id || c.ctaId === id) && c.kind === kind) out[c.mode] = Number(c.n);
    return out;
  };
  return {
    webinar,
    polls: polls.map((p) => ({ ...p, answers: count(p.id, "poll_answer") })),
    ctas: ctas.map((c) => ({ ...c, shown: count(c.id, "cta_shown"), clicked: count(c.id, "cta_clicked") })),
    presenters: presenters.map((p) => ({ ...p.presenter, email: p.userEmail ?? p.personEmail ?? null })),
    series,
    registrations: Number(regs[0]?.n ?? 0),
    broadcastJob: broadcastJobs[0] ? { status: broadcastJobs[0].status, lastError: broadcastJobs[0].lastError, attempts: Number(broadcastJobs[0].attempts) } : null,
  };
}

/** Active staff users for the owner and presenter pickers. */
export async function listStaffOptions(db: DbOrTx): Promise<Array<{ id: string; label: string }>> {
  const rows = await db
    .select({ id: users.id, name: users.name, email: users.email })
    .from(users)
    .where(and(eq(users.audience, "staff"), eq(users.status, "active")))
    .orderBy(asc(users.name), asc(users.email));
  return rows.map((r) => ({ id: r.id, label: r.name ? `${r.name} (${r.email})` : r.email }));
}
