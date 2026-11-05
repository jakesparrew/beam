/**
 * webinar queries (webinar spec 4.3; webinar-P2): the staff list with its tabs, one webinar with
 * its polls, CTAs, presenters, series and broadcast job state, and the staff owner options.
 * Every function takes the caller's database or transaction first. webinar-P3 adds the public
 * landing data, the public and portal lists and the registrant list; webinar-P5 the host console
 * state (`getHostConsoleState`, built in `server/interactions.ts`); later packages the reports.
 */
import { jobs, persons, users, vWebinarWatch, watchSegments, webinarCtas, webinarInteractions, webinarPolls, webinarPresenters, webinarRegistrations, webinars } from "@beam/db/schema";
import type { Locale } from "@beam/core/i18n";
import { canRegister, registeredModeFor, replayAccess, resolveMode, type WatchMode, type WebinarMode, type WebinarStatus } from "@beam/core/webinar";
import { and, asc, desc, eq, inArray, ne, or, sql, type DbOrTx, type SQL } from "@/lib/ctx";
import { rowsOf } from "@/lib/sensitive";
import { resolvePersonIds } from "@/modules/crm/api";
export { getHostConsoleState, type HostConsoleState, type HostCta, type HostPoll, type MessageRow } from "./server/interactions";
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

// ---------------------------------------------------------------------------------------------
// Admin page labels (server side: the client editors take every text as a prop)
// ---------------------------------------------------------------------------------------------

type Tr = (key: string, params?: Record<string, string | number>) => string;

const ERROR_KEYS = [
  "validation", "conflict", "not_found", "forbidden", "unauthorized", "rate_limited", "internal", "stale_version", "slug_taken", "slug_locked",
  "already_started", "missing_locales", "not_publishable", "never_published", "poll_answered", "cta_shown", "key_taken", "invalid_tag_rules",
  "invalid_transition", "starts_at_past", "starts_at_required", "on_demand_has_no_start", "video_processing", "video_missing", "live_only",
  "presenter_exists", "occurrence_count", "webinar_cancelled", "webinar_archived",
] as const;

/** `webinar.admin.errors.*` keyed by error code or message. */
export function adminErrorLabels(tr: Tr): Record<string, string> {
  return Object.fromEntries(ERROR_KEYS.map((k) => [k, tr(`webinar.admin.errors.${k}`)]));
}

export function localeNames(tr: Tr) {
  return { "nl-BE": tr("platform.shell.locale_nl"), "fr-BE": tr("platform.shell.locale_fr"), en: tr("platform.shell.locale_en") } as const;
}

/** `LocalizedInput` labels for a field. */
export function localizedLabels(tr: Tr, field: string) {
  return { field, locales: localeNames(tr), missing: tr("webinar.admin.form.locale_missing"), complete: tr("webinar.admin.form.locale_complete") };
}

export function fieldNames(tr: Tr): Record<string, string> {
  const f = (k: string) => tr(`webinar.admin.fields.${k}`, k === "poll" || k === "cta" ? { key: "{key}" } : undefined);
  return Object.fromEntries(["title", "description", "startsAt", "spokenLocale", "video", "tagRules", "poll", "cta"].map((k) => [k, f(k)]));
}

/** The labels of `WebinarForm` (create and edit). */
export function webinarFormLabels(tr: Tr) {
  const g = (k: string) => tr(`webinar.admin.form.${k}`);
  const modes = ["live", "simulive", "on_demand"] as const;
  return {
    mode: g("mode"),
    modes: Object.fromEntries(modes.map((m) => [m, tr(`webinar.enum.mode.${m}`)])) as Record<(typeof modes)[number], string>,
    modeHints: Object.fromEntries(modes.map((m) => [m, g(`mode_hint.${m}`)])) as Record<(typeof modes)[number], string>,
    slug: g("slug"),
    slugHint: g("slug_hint"),
    title: localizedLabels(tr, g("title")),
    description: localizedLabels(tr, g("description")),
    locales: g("locales"),
    localeNames: localeNames(tr),
    spokenLocale: g("spoken_locale"),
    startsAt: g("starts_at"),
    startsAtHint: g("starts_at_hint"),
    duration: g("duration"),
    owner: g("owner"),
    seriesKey: g("series_key"),
    seriesHint: g("series_hint"),
    replay: g("replay"),
    isReplayEnabled: g("is_replay_enabled"),
    isReplayGated: g("is_replay_gated"),
    replayUntil: g("replay_until"),
    replayViewLimit: g("replay_view_limit"),
    onDemandAccessDays: g("on_demand_access_days"),
    thresholds: g("thresholds"),
    attendedMinutes: g("attended_minutes"),
    conversionWindow: g("conversion_window"),
    interaction: g("interaction"),
    chatEnabled: g("chat_enabled"),
    questionsEnabled: g("questions_enabled"),
    meetUrl: g("meet_url"),
    meetHint: g("meet_hint"),
    save: g("save"),
    saveDraft: g("save_draft"),
    saving: g("saving"),
    saved: g("saved"),
    created: g("created"),
    errors: adminErrorLabels(tr),
    missingFor: tr("webinar.admin.detail.missing_for", { field: "{field}", locales: "{locales}" }),
    fieldNames: fieldNames(tr),
  };
}

/** Every webinar row (the first-run empty state of `/admin/webinars`). */
export async function countWebinars(db: DbOrTx): Promise<number> {
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(webinars);
  return Number(row?.n ?? 0);
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

// ---------------------------------------------------------------------------------------------
// webinar-P3: public pages, the portal list and the registrant list
// ---------------------------------------------------------------------------------------------

/** Statuses a visitor can see (forms' read contract: linkable while published, live or ended). */
export const PUBLIC_STATUSES: readonly WebinarStatus[] = ["published", "live", "ended"];

const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
const durationSecOf = (w: Pick<WebinarRow, "durationSec" | "plannedDurationMinutes">) => w.durationSec ?? w.plannedDurationMinutes * 60;
const endMs = (w: Pick<WebinarRow, "startsAt" | "durationSec" | "plannedDurationMinutes">) => (w.startsAt ? w.startsAt.getTime() + durationSecOf(w) * 1000 : null);

/**
 * What the landing page shows (section 5.3): `register` (registration open), `replay` (open for
 * the replay after the end), `closed_ended` (ended without an open replay), `cancelled`, or
 * `wrong_locale` when the URL locale is not one of the webinar's locales.
 */
export type LandingState = "register" | "replay" | "closed_ended" | "cancelled" | "wrong_locale";

export type PublicWebinar = {
  webinar: WebinarRow;
  presenters: Array<{ displayName: string; role: PresenterRow["role"] }>;
  state: LandingState;
};

/**
 * The public landing data of a slug (section 4.3 `getWebinarBySlug`): published, live and ended
 * webinars plus the cancelled notice; drafts and archived webinars are not found.
 */
export async function getWebinarBySlug(db: DbOrTx, slug: string, locale: Locale, now: Date = new Date()): Promise<PublicWebinar | null> {
  const [w] = await db.select().from(webinars).where(eq(webinars.slug, slug));
  if (!w || (w.status !== "cancelled" && !PUBLIC_STATUSES.includes(w.status))) return null;
  const presenters = await db
    .select({ displayName: webinarPresenters.displayName, role: webinarPresenters.role })
    .from(webinarPresenters)
    .where(eq(webinarPresenters.webinarId, w.id))
    .orderBy(asc(webinarPresenters.sortOrder), asc(webinarPresenters.createdAt));
  let state: LandingState;
  if (w.status === "cancelled") state = "cancelled";
  else if (!w.locales.includes(locale)) state = "wrong_locale";
  else if (!canRegister(w, now).ok) state = "closed_ended";
  else state = w.mode !== "on_demand" && registeredModeFor(w, now) === "replay" ? "replay" : "register";
  return { webinar: w, presenters, state };
}

/** The slug of a webinar id when it is public (the 308 fallback of `/[locale]/webinars/[id]`). */
export async function publicSlugById(db: DbOrTx, idOrSlug: string): Promise<string | null> {
  if (!isUuid(idOrSlug)) return null;
  const [w] = await db.select({ slug: webinars.slug, status: webinars.status }).from(webinars).where(eq(webinars.id, idOrSlug.toLowerCase()));
  return w && (w.status === "cancelled" || PUBLIC_STATUSES.includes(w.status)) ? w.slug : null;
}

/** Upcoming (or live) live and simulive webinars, then published on-demand ones, in `locale`. */
export async function listPublicWebinarRows(db: DbOrTx, opts: { locale: Locale; from: Date; limit: number }): Promise<WebinarRow[]> {
  return db
    .select()
    .from(webinars)
    .where(
      and(
        sql`${opts.locale} = any(${webinars.locales})`,
        or(
          and(eq(webinars.mode, "on_demand"), eq(webinars.status, "published")),
          and(
            ne(webinars.mode, "on_demand"),
            inArray(webinars.status, ["published", "live"]),
            sql`${webinars.startsAt} + make_interval(secs => coalesce(${webinars.durationSec}, ${webinars.plannedDurationMinutes} * 60)) >= ${opts.from}`,
          ),
        ),
      ),
    )
    .orderBy(sql`case when ${webinars.mode} = 'on_demand' then 1 else 0 end`, sql`${webinars.startsAt} asc nulls last`, desc(webinars.publishedAt), asc(webinars.id))
    .limit(Math.max(1, Math.min(opts.limit, 200)));
}

const zeroModes = <T,>(v: T): Record<WatchMode, T> => ({ live: v, replay: v, on_demand: v });

type RegistrationRecord = typeof webinarRegistrations.$inferSelect;

export type PersonRegistrationRow = {
  registration: RegistrationRecord;
  webinar: WebinarRow;
  watchedSec: Record<WatchMode, number>;
  attended: Record<WatchMode, boolean>;
};

/**
 * Every registration of the person and of the persons merged into them, one per webinar (the
 * person's own registration wins over a merged one, edge case 19), newest first, with the merged
 * watch time per mode from `v_webinar_watch`.
 */
export async function listPersonRegistrations(db: DbOrTx, personId: string): Promise<PersonRegistrationRow[]> {
  const ids = await resolvePersonIds(db, personId).catch(() => [personId]);
  const canonical = ids[0] ?? personId;
  const rows = await db
    .select({ r: webinarRegistrations, w: webinars })
    .from(webinarRegistrations)
    .innerJoin(webinars, eq(webinars.id, webinarRegistrations.webinarId))
    .where(inArray(webinarRegistrations.personId, ids))
    .orderBy(desc(webinarRegistrations.createdAt), asc(webinarRegistrations.id));
  const byWebinar = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    const seen = byWebinar.get(row.w.id);
    if (!seen || (seen.r.personId !== canonical && row.r.personId === canonical)) byWebinar.set(row.w.id, row);
  }
  const watch = await db.select().from(vWebinarWatch).where(inArray(vWebinarWatch.personId, ids));
  return [...byWebinar.values()].map(({ r, w }) => {
    const watchedSec = zeroModes(0);
    const attended = zeroModes(false);
    for (const x of watch.filter((v) => v.webinarId === w.id)) {
      watchedSec[x.mode] = Math.max(watchedSec[x.mode], Number(x.watchedSec));
      attended[x.mode] = attended[x.mode] || x.isAttended === true;
    }
    return { registration: r, webinar: w, watchedSec, attended };
  });
}

/** A live or simulive webinar still to come or live (the live part not over). */
export function isUpcoming(w: WebinarRow, now: Date): boolean {
  if (w.mode === "on_demand" || !(w.status === "published" || w.status === "live")) return false;
  if (w.status === "live") return true;
  const end = endMs(w);
  return end !== null && end > now.getTime();
}

export type MyWebinarItem = {
  webinar: WebinarRow;
  registration: RegistrationRecord | null;
  /** Replay or on-demand: when access ends (`replay_until_at` or the on-demand days); null = no end. */
  availableUntil: Date | null;
  /** Views left under `replay_view_limit`; null = unlimited. */
  viewsLeft: number | null;
};

export type MyWebinars = { upcoming: MyWebinarItem[]; watchAgain: MyWebinarItem[]; onDemand: MyWebinarItem[] };

/** Counted views per registration and mode: a `started` more than 30 minutes after the previous one (rule 31). */
async function countedViews(db: DbOrTx, registrationIds: string[]): Promise<Map<string, number>> {
  if (!registrationIds.length) return new Map();
  const rows = rowsOf<{ registration_id: string; mode: string; views: number }>(
    await db.execute(sql`select registration_id::text as registration_id, mode::text as mode, count(*)::int as views from (
        select registration_id, mode, occurred_at,
               lag(occurred_at) over (partition by registration_id, mode order by occurred_at) as prev
        from webinar_interactions
        where kind = 'started' and registration_id in (${sql.join(
          registrationIds.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})
      ) s where prev is null or occurred_at - prev > interval '30 minutes'
      group by 1, 2`),
  );
  return new Map(rows.map((r) => [`${r.registration_id}:${r.mode}`, Number(r.views)]));
}

/**
 * The portal list (section 5.2, `listMyWebinars`): Upcoming (registered, not ended), Watch again
 * (registered, a replay this registration may watch) and the On-demand library (published
 * on-demand webinars in `locale`, with the person's registration when there is one).
 */
export async function listMyWebinars(db: DbOrTx, personId: string, locale: Locale, now: Date = new Date()): Promise<MyWebinars> {
  const regs = (await listPersonRegistrations(db, personId)).filter((x) => x.registration.status === "registered");
  const views = await countedViews(
    db,
    regs.map((x) => x.registration.id),
  );
  const upcoming: MyWebinarItem[] = [];
  const watchAgain: MyWebinarItem[] = [];
  const onDemandRegs = new Map<string, MyWebinarItem>();
  for (const { registration, webinar: w } of regs) {
    if (isUpcoming(w, now)) {
      upcoming.push({ webinar: w, registration, availableUntil: null, viewsLeft: null });
      continue;
    }
    const mode = resolveMode(w, now);
    if (!("mode" in mode) || mode.mode === "live") continue;
    const used = views.get(`${registration.id}:${mode.mode}`) ?? 0;
    const access = replayAccess({ w, registration, viewsInMode: used, now });
    if (!access.ok && access.code === "expired") continue;
    const days = w.mode === "on_demand" && w.onDemandAccessDays ? new Date(registration.createdAt.getTime() + w.onDemandAccessDays * 86_400_000) : null;
    const until = [w.replayUntilAt, days].filter((d): d is Date => d instanceof Date).sort((a, b) => a.getTime() - b.getTime())[0] ?? null;
    const item: MyWebinarItem = { webinar: w, registration, availableUntil: until, viewsLeft: w.replayViewLimit === null ? null : Math.max(0, w.replayViewLimit - used) };
    if (mode.mode === "on_demand") onDemandRegs.set(w.id, item);
    else watchAgain.push(item);
  }
  upcoming.sort((a, b) => (a.webinar.startsAt?.getTime() ?? 0) - (b.webinar.startsAt?.getTime() ?? 0));
  const library = await db
    .select()
    .from(webinars)
    .where(and(eq(webinars.mode, "on_demand"), eq(webinars.status, "published"), sql`${locale} = any(${webinars.locales})`))
    .orderBy(desc(webinars.publishedAt), asc(webinars.id));
  const onDemand = library
    .filter((w) => !(w.replayUntilAt && w.replayUntilAt.getTime() <= now.getTime()))
    .map((w) => onDemandRegs.get(w.id) ?? { webinar: w, registration: null, availableUntil: w.replayUntilAt, viewsLeft: w.replayViewLimit });
  return { upcoming, watchAgain, onDemand };
}

export const REGISTRATIONS_PAGE_SIZE = 100;

export type RegistrantRow = {
  id: string;
  personId: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  status: RegistrationRecord["status"];
  personStatus: RegistrationRecord["personStatus"];
  registeredMode: WatchMode;
  source: RegistrationRecord["source"];
  mutedAt: Date | null;
  createdAt: Date;
  lastActivityAt: Date | null;
  watchedSec: Record<WatchMode, number>;
};

/**
 * The registrant list of `/admin/webinars/[id]/registrations` (section 4.3 `listRegistrations`;
 * the page checks `webinars.host` and `persons.read`). `q` matches the name or the email.
 */
export async function listRegistrations(
  db: DbOrTx,
  webinarId: string,
  opts: { status?: RegistrantRow["status"]; personStatus?: RegistrantRow["personStatus"]; q?: string; page?: number } = {},
): Promise<{ rows: RegistrantRow[]; total: number; hasMore: boolean }> {
  const page = Math.max(1, opts.page ?? 1);
  const where: SQL[] = [eq(webinarRegistrations.webinarId, webinarId)];
  if (opts.status) where.push(eq(webinarRegistrations.status, opts.status));
  if (opts.personStatus) where.push(eq(webinarRegistrations.personStatus, opts.personStatus));
  const q = opts.q?.trim();
  if (q) where.push(sql`(${persons.email} ilike ${`%${q}%`} or (coalesce(${persons.firstName}, '') || ' ' || coalesce(${persons.lastName}, '')) ilike ${`%${q}%`})`);
  const [count] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(webinarRegistrations)
    .innerJoin(persons, eq(persons.id, webinarRegistrations.personId))
    .where(and(...where));
  const rows = await db
    .select({
      r: webinarRegistrations,
      firstName: persons.firstName,
      lastName: persons.lastName,
      email: persons.email,
      lastSegmentAt: sql<string | null>`(select max(${watchSegments.recordedAt})::text from ${watchSegments} where ${watchSegments.registrationId} = ${webinarRegistrations.id})`,
    })
    .from(webinarRegistrations)
    .innerJoin(persons, eq(persons.id, webinarRegistrations.personId))
    .where(and(...where))
    .orderBy(desc(webinarRegistrations.createdAt), asc(webinarRegistrations.id))
    .limit(REGISTRATIONS_PAGE_SIZE + 1)
    .offset((page - 1) * REGISTRATIONS_PAGE_SIZE);
  const regIds = rows.map((x) => x.r.id);
  const watch = regIds.length
    ? await db
        .select({ registrationId: vWebinarWatch.registrationId, mode: vWebinarWatch.mode, watchedSec: vWebinarWatch.watchedSec })
        .from(vWebinarWatch)
        .where(inArray(vWebinarWatch.registrationId, regIds))
    : [];
  return {
    rows: rows.slice(0, REGISTRATIONS_PAGE_SIZE).map(({ r, firstName, lastName, email, lastSegmentAt }) => {
      const watchedSec = zeroModes(0);
      for (const x of watch) if (x.registrationId === r.id) watchedSec[x.mode] = Number(x.watchedSec);
      const segAt = lastSegmentAt ? new Date(lastSegmentAt) : null;
      const lastActivityAt = segAt && segAt.getTime() > r.updatedAt.getTime() ? segAt : r.updatedAt;
      return {
        id: r.id,
        personId: r.personId,
        firstName,
        lastName,
        email,
        status: r.status,
        personStatus: r.personStatus,
        registeredMode: r.registeredMode,
        source: r.source,
        mutedAt: r.mutedAt,
        createdAt: r.createdAt,
        lastActivityAt,
        watchedSec,
      };
    }),
    total: Number(count?.n ?? 0),
    hasMore: rows.length > REGISTRATIONS_PAGE_SIZE,
  };
}

// ---------------------------------------------------------------------------------------------
// webinar-P3 labels (server side; the client form takes every text as a prop)
// ---------------------------------------------------------------------------------------------

/** Error message or code -> text for the registration paths (`webinar.register.errors.*`). */
export function registerErrorLabels(tr: Tr): Record<string, string> {
  const e = (k: string) => tr(`webinar.register.errors.${k}`);
  return {
    "webinar.register.closed": e("closed"),
    "webinar.access.blocked": e("blocked"),
    closed: e("closed"),
    blocked: e("blocked"),
    rate_limited: e("rate_limited"),
    validation: e("validation"),
    not_found: e("not_found"),
    unauthorized: e("unauthorized"),
    conflict: e("conflict"),
    internal: e("internal"),
  };
}

/** The labels of `RegistrationForm`. */
export function registrationFormLabels(tr: Tr) {
  const g = (k: string) => tr(`webinar.register.${k}`);
  return {
    email: g("email"),
    firstName: g("first_name"),
    lastName: g("last_name"),
    consentLegend: g("consent_legend"),
    consentEvents: g("consent_events"),
    consentNewsletter: g("consent_newsletter"),
    consentHint: g("consent_hint"),
    privacyBefore: g("privacy_before"),
    privacyLink: g("privacy_link"),
    submit: g("submit"),
    submitPortal: g("submit_portal"),
    submitting: g("submitting"),
    successTitle: g("success_title"),
    successBody: g("success_body"),
    successPortal: g("success_portal"),
    errors: registerErrorLabels(tr),
  };
}
