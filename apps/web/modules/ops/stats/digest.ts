/**
 * `ops.daily_digest` (ops rule 71, edge cases 26 and 37): one Slack message at 08:00 Brussels
 * about the previous Brussels day. Each source runs in its own savepoint and `try`; a failing
 * source prints "unavailable" for its section, is reported to Sentry, and the rest still posts.
 * Ids, slugs, keys and counts only: never a name, an email address or a phone number.
 *
 * R2 (ops-P7): the webinars of the next 48 hours from webinar's `listUpcomingWebinarHealth`, one
 * line per webinar in start order with its id and states only (mode, YouTube lifecycle,
 * broadcast error yes or no), never its title or the error text. While webinar's function is
 * not implemented the section is left out.
 *
 * R3 (rule 74): while `ff_ops_marketing` is on and an ads account is configured, an "Ads" section
 * gives the data age ("data as of <date>") and one line per account whose last successful pull
 * is `ADS_STALE_DAYS` or more days old (`getStaleAdsAccounts`, platform and account id only);
 * any such account also raises a Normal alert of its own (fingerprint `ads-stale`).
 *
 * `ops_state.digest_last_sent_on` stops a second post on the same day (edge case 26).
 */
import type { DbOrTx } from "@beam/db";
import { brusselsDate } from "@beam/core/ops";
import { notifySlack } from "@/lib/alerts";
import { sql, type Ctx } from "@/lib/ctx";
import { reportError } from "@/lib/logger";
import { rowsOf } from "@/lib/sensitive";
import { countAutomationIssues } from "@/modules/automation/api";
import { getBookingHealth } from "@/modules/booking/api";
import { countSegmentRefreshErrors } from "@/modules/crm/api";
import { getFinanceDigest } from "@/modules/finance/api";
import { getFormsHealth } from "@/modules/forms/api";
import { getPlatformDigest, type DigestSection } from "@/modules/platform/api";
import { listUpcomingWebinarHealth } from "@/modules/webinar/api";
import { NotImplementedError } from "@beam/core/errors";
import { ADS_STALE_DAYS, adsDataAsOf, configuredAccounts, getStaleAdsAccounts, marketingEnabled, readAdsSettings } from "../marketing/ads";

export type DigestBlock = { title: string; lines: string[] };

/** Rule 71: a published form with at least this many views and no completion gets a "check form" line. */
export const CHECK_FORM_MIN_VIEWS = 20;
/** Rule 58: a privacy request is flagged 25 days after receipt (5 days before its due date). */
export const PRIVACY_WARN_DAYS_BEFORE_DUE = 5;

const DIGEST_STATE = "digest_last_sent_on";

/** The Brussels date before `isoDate`. */
export function previousDay(isoDate: string): string {
  const d = new Date(`${isoDate}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

const one = async <T>(db: DbOrTx, q: ReturnType<typeof sql>): Promise<T> => rowsOf<T>(await db.execute(q))[0]!;
const n = (v: unknown) => Number(v ?? 0);
/** `[day 00:00, next day 00:00)` in Brussels as SQL bounds. */
const dayStart = (day: string) => sql`(${day}::date::timestamp at time zone 'Europe/Brussels')`;
const dayEnd = (day: string) => sql`((${day}::date + 1)::timestamp at time zone 'Europe/Brussels')`;

/** A source's lines, or `null` to leave the section out (a release source whose owner has not landed yet). */
type Source = { title: string; build: (db: DbOrTx) => Promise<string[] | null> };

const isStub = (e: unknown) => e instanceof NotImplementedError || (e as { name?: string } | null)?.name === "NotImplementedError";

/** Rule 71 (R2): the webinars of the next 48 hours with ids and states only. */
async function webinarLines(db: DbOrTx): Promise<string[] | null> {
  let rows: Awaited<ReturnType<typeof listUpcomingWebinarHealth>>;
  try {
    rows = await listUpcomingWebinarHealth(db, { hours: 48 });
  } catch (error) {
    if (isStub(error)) return null;
    throw error;
  }
  const sorted = [...rows].sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime() || a.webinarId.localeCompare(b.webinarId));
  return [
    `next 48 h ${sorted.length}`,
    ...sorted.map(
      (w) =>
        `${w.broadcastError ? "(!) " : ""}${w.webinarId}: ${w.mode}, broadcast ${w.youtubeLifecycle ?? "none"}${w.broadcastError ? ", broadcast error" : ""}`,
    ),
  ];
}

type StaleAdsAccount = Awaited<ReturnType<typeof getStaleAdsAccounts>>[number];

const staleText = (a: StaleAdsAccount) =>
  `${a.platform} ${a.accountId}: ${a.daysSincePull === null ? "never pulled" : `last successful pull ${a.daysSincePull} days ago`}`;

/** Rule 74: the stale ads accounts, or `null` while `ff_ops_marketing` is off or no account is configured. */
async function staleAds(db: DbOrTx, now: Date): Promise<StaleAdsAccount[] | null> {
  if (!(await marketingEnabled(db))) return null;
  if (configuredAccounts(await readAdsSettings(db)).length === 0) return null;
  return getStaleAdsAccounts(db, now);
}

/** Rule 74 (R3): the ads data age and the accounts without a successful pull for `ADS_STALE_DAYS` days. */
async function adsLines(db: DbOrTx, now: Date): Promise<string[] | null> {
  const stale = await staleAds(db, now);
  if (!stale) return null;
  return [`data as of ${(await adsDataAsOf(db)) ?? "none"}`, ...stale.map((a) => `(!) ${staleText(a)}`)];
}

/** Rule 74: one Normal alert when an ads account has had no successful pull for `ADS_STALE_DAYS` days. */
async function alertStaleAds(ctx: Ctx): Promise<void> {
  let stale: StaleAdsAccount[] | null;
  let asOf: string | null = null;
  try {
    [stale, asOf] = await ctx.tx.transaction(async (sp) => [await staleAds(sp, ctx.now), await adsDataAsOf(sp)] as const);
  } catch (error) {
    reportError(error, { tags: { job: "ops.daily_digest", section: "Ads alert" } });
    return;
  }
  if (!stale?.length) return;
  await notifySlack(ctx, {
    fingerprint: "ads-stale",
    severity: "normal",
    text: [`Ads data is stale (no successful pull for ${ADS_STALE_DAYS} days or more); dashboards show data as of ${asOf ?? "none"}.`, ...stale.map((a) => `- ${staleText(a)}`)].join("\n"),
  });
}

function fromSection(section: DigestSection): string[] {
  return section.lines.map((l) => `${l.level === "ok" ? "" : l.level === "warn" ? "(!) " : "(!!) "}${l.label}: ${l.value}`);
}

/** The sources of rule 71, in message order. */
export function digestSources(input: { day: string; today: string; now: Date }): Source[] {
  const { day, today } = input;
  const since = new Date(`${day}T00:00:00Z`);
  return [
    {
      title: "Email",
      build: async (db) => {
        const r = await one<{ sent: number; bounced: number; complained: number; blocked: number }>(
          db,
          sql`select count(*) filter (where sent_at >= ${dayStart(day)} and sent_at < ${dayEnd(day)})::int as sent,
                     count(*) filter (where bounced_at >= ${dayStart(day)} and bounced_at < ${dayEnd(day)})::int as bounced,
                     count(*) filter (where complained_at >= ${dayStart(day)} and complained_at < ${dayEnd(day)})::int as complained,
                     count(*) filter (where status = 'blocked_translation' and queued_at >= ${dayStart(day)} and queued_at < ${dayEnd(day)})::int as blocked
              from email_messages`,
        );
        const rate = n(r.sent) > 0 ? ((n(r.bounced) / n(r.sent)) * 100).toFixed(1) : "0.0";
        return [`sent ${n(r.sent)}, bounced ${n(r.bounced)}, complaints ${n(r.complained)}, bounce rate ${rate} %`, `blocked_translation ${n(r.blocked)}`];
      },
    },
    {
      title: "Automation",
      build: async (db) => {
        const a = await countAutomationIssues(db, since);
        return [
          `failed runs ${n(a.failed)}, skipped translations ${n(a.skippedTranslation)}, stuck enrolments ${n(a.stuck)}, evaluator lag ${n(a.evaluatorLagSeconds)} s`,
        ];
      },
    },
    {
      title: "Payments",
      build: async (db) => {
        const r = await one<{ failed: number }>(
          db,
          sql`select count(*)::int as failed from payments
              where status in ('failed', 'expired') and updated_at >= ${dayStart(day)} and updated_at < ${dayEnd(day)}`,
        );
        return [`failed or expired ${n(r.failed)}`];
      },
    },
    {
      title: "Privacy requests",
      build: async (db) => {
        const r = await one<{ near_due: number; followup: number }>(
          db,
          sql`select count(*) filter (where status in ('received', 'verified', 'running', 'failed')
                                       and due_on <= ${today}::date + ${PRIVACY_WARN_DAYS_BEFORE_DUE}::int)::int as near_due,
                     count(*) filter (where needs_manual_followup and status <> 'cancelled')::int as followup
              from privacy_requests`,
        );
        return [`near or past due ${n(r.near_due)}, manual follow-up ${n(r.followup)}`];
      },
    },
    {
      title: "Imports",
      build: async (db) => {
        const r = await one<{ done: number; failed: number }>(
          db,
          sql`select count(*) filter (where status = 'done')::int as done, count(*) filter (where status = 'failed')::int as failed
              from imports where finished_at >= ${dayStart(day)} and finished_at < ${dayEnd(day)}`,
        );
        return [`finished ${n(r.done)}, failed ${n(r.failed)}`];
      },
    },
    {
      title: "Retention policies",
      build: async (db) => {
        const rows = rowsOf<{ key: string }>(
          await db.execute(sql`select key from retention_policies where is_active and last_run_status = 'no_handler' order by key`),
        );
        return [`no handler ${rows.length}${rows.length ? `: ${rows.map((r) => r.key).join(", ")}` : ""}`];
      },
    },
    {
      title: "Segments",
      build: async (db) => [`refresh errors ${n(await countSegmentRefreshErrors(db))}`],
    },
    {
      title: "Forms",
      build: async (db) => {
        const h = await getFormsHealth(db, { day });
        const quiet = rowsOf<{ slug: string; views: number }>(
          await db.execute(sql`select f.slug, v.views from v_form_funnel_daily v join forms f on f.id = v.form_id
            where f.status = 'published' and v.day_on = ${day}::date and v.views >= ${CHECK_FORM_MIN_VIEWS} and v.completed = 0
            order by f.slug`),
        );
        return [
          `completions ${n(h.completions)}, starts ${n(h.started)}, import failures ${n(h.importFailed)}, import skips ${n(h.importSkipped)}, broken CTAs ${n(h.formsWithBrokenCtas)}`,
          ...quiet.map((q) => `check form ${q.slug} (${n(q.views)} views, 0 completions)`),
        ];
      },
    },
    {
      title: "Booking",
      build: async (db) => {
        const b = await getBookingHealth(db);
        return [
          `${b.level === "ok" ? "" : `(${b.level}) `}materialised through ${b.materialisedThroughOn}, overdue offers ${n(b.overdueOffers)}, overdue reservations ${n(b.overdueReservations)}, unsent confirmations (24 h) ${n(b.unsentConfirmations24h)}`,
        ];
      },
    },
    { title: "Webinars", build: webinarLines },
    { title: "Ads", build: (db) => adsLines(db, input.now) },
    { title: "Platform", build: async (db) => fromSection(await getPlatformDigest(db, day)) },
    { title: "Finance", build: async (db) => fromSection(await getFinanceDigest(db, day)) },
  ];
}

/** Runs every source in its own savepoint; a failing one becomes "unavailable". */
export async function buildDigestBlocks(db: DbOrTx, input: { day: string; today: string; now: Date }): Promise<DigestBlock[]> {
  const blocks: DigestBlock[] = [];
  for (const source of digestSources(input)) {
    try {
      const lines = await db.transaction((sp) => source.build(sp));
      if (lines) blocks.push({ title: source.title, lines });
    } catch (error) {
      reportError(error, { tags: { job: "ops.daily_digest", section: source.title } });
      blocks.push({ title: source.title, lines: ["unavailable"] });
    }
  }
  return blocks;
}

/** The Slack text: a header, then one block per section. */
export function formatDigest(day: string, blocks: DigestBlock[]): string {
  const body = blocks.map((b) => (b.lines.length === 1 ? `*${b.title}*: ${b.lines[0]}` : `*${b.title}*\n${b.lines.map((l) => `- ${l}`).join("\n")}`));
  return [`BEAM daily digest for ${day}`, ...body].join("\n");
}

/**
 * The job body: locks `ops_state.digest_last_sent_on`, returns early when today's digest was
 * already posted, otherwise posts through `notifySlack` (fingerprint `digest`) and stores today.
 */
export async function runDigest(ctx: Ctx): Promise<unknown> {
  const today = brusselsDate(ctx.now);
  const day = previousDay(today);
  await ctx.tx.execute(sql`insert into ops_state (key, value) values (${DIGEST_STATE}, 'null'::jsonb) on conflict (key) do nothing`);
  const state = rowsOf<{ value: unknown }>(await ctx.tx.execute(sql`select value from ops_state where key = ${DIGEST_STATE} for update`))[0];
  const last = typeof state?.value === "string" ? state.value : (state?.value as { on?: string } | null)?.on;
  if (last === today) return { skipped: "already_sent", day };
  const blocks = await buildDigestBlocks(ctx.tx, { day, today, now: ctx.now });
  const text = formatDigest(day, blocks);
  await notifySlack(ctx, { fingerprint: "digest", severity: "normal", text });
  await alertStaleAds(ctx);
  await ctx.tx.execute(sql`update ops_state set value = ${JSON.stringify(today)}::jsonb, updated_at = now() where key = ${DIGEST_STATE}`);
  return { day, sections: blocks.length, unavailable: blocks.filter((b) => b.lines[0] === "unavailable").map((b) => b.title) };
}
