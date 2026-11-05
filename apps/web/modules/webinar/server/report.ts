/**
 * Webinar reporting (webinar spec rules 39-41, sections 4.3 and 5.1; webinar-P6).
 *
 * - `getWebinarReport`: per `person_status` snapshot (lead, customer, member) and in total, per
 *   mode: registered, started, attended, the 15m/30m/50 %/end thresholds, average watch minutes,
 *   poll responses, CTAs shown and clicked; then booked, purchased and converted within the
 *   period, revenue in the period and the conversion rate (converted ÷ registrations). Plus
 *   poll results per option per mode, the CTA table and the UTM table.
 * - Registration is never attendance (rule 17): "registered" counts registrations, "attended"
 *   only `v_webinar_watch.is_attended`.
 * - Every count is per resolved person (`v_webinar_registration_facts` folds a merged loser's
 *   registration into the winner's row); cancelled registrations are left out.
 * - Conversion is counted from `anchor_at` (the start for live registrants, the registration
 *   otherwise) up to `anchor_at + period`; "booked after" and "purchased after" a CTA from the
 *   person's first click of that CTA (rule 40). A purchase before the anchor never counts.
 * - `buildReportCsv` holds aggregates only (rule 41); `buildRegistrantsCsv` is the personal
 *   export behind `persons.export` (`exportWebinarRegistrants`).
 */
import type { LocalizedText } from "@beam/core/i18n";
import { PERSON_STATUS_SNAPSHOTS, WATCH_MODES, type PersonStatusSnapshot, type WatchMode } from "@beam/core/webinar";
import { sql, type DbOrTx } from "@/lib/ctx";
import { rowsOf } from "@/lib/sensitive";

/** The periods the report offers (rule 40). */
export const REPORT_PERIODS = [7, 14, 30, 60, 90, 180] as const;
export type ReportPeriod = (typeof REPORT_PERIODS)[number];

export const isReportPeriod = (n: number): n is ReportPeriod => (REPORT_PERIODS as readonly number[]).includes(n);

/** Segment keys of the report. */
export const REPORT_SEGMENTS = PERSON_STATUS_SNAPSHOTS;
export type ReportSegment = PersonStatusSnapshot;

export type ModeRow = {
  /** Registrations whose registered mode is this mode. */
  registered: number;
  started: number;
  attended: number;
  watched15m: number;
  watched30m: number;
  watchedHalf: number;
  watchedEnd: number;
  /** Persons with watch time in this mode. */
  viewers: number;
  watchSec: number;
  /** `watchSec / viewers / 60`, one decimal; 0 without viewers. */
  avgWatchMinutes: number;
  pollResponses: number;
  ctaShown: number;
  ctaClicked: number;
};

export type SegmentRow = {
  registrations: number;
  modes: Record<WatchMode, ModeRow>;
  booked: number;
  purchased: number;
  /** Persons with a first booking or a paid order in the period. */
  converted: number;
  revenueCents: number;
  /** `converted / registrations` (0 without registrations). */
  conversionRate: number;
};

export type PollResult = {
  pollId: string;
  key: string;
  question: LocalizedText;
  isActive: boolean;
  allowMultiple: boolean;
  options: Array<{ key: string; label: LocalizedText; counts: Record<WatchMode, number> }>;
  respondents: Record<WatchMode, number>;
};

export type CtaResult = {
  ctaId: string;
  key: string;
  label: LocalizedText;
  url: string;
  isActive: boolean;
  /** Persons the CTA was shown to, per mode. */
  shown: Record<WatchMode, number>;
  /** Persons who clicked, per mode. */
  clicked: Record<WatchMode, number>;
  /** Persons who clicked ÷ persons shown (all modes); null when never shown. */
  ctr: number | null;
  /** Clickers with a confirmed or attended booking created after their first click, in the period. */
  bookedAfter: number;
  /** Clickers with a paid order after their first click, in the period. */
  purchasedAfter: number;
};

export type UtmRow = { source: string | null; campaign: string | null; registrations: number; attended: number; converted: number };

export type WebinarReport = {
  totals: SegmentRow;
  bySegment: Record<ReportSegment, SegmentRow>;
  byMode: Record<WatchMode, ModeRow>;
  polls: PollResult[];
  ctas: CtaResult[];
  utm: UtmRow[];
  periodDays: number;
  /** Registrations exist but their watch segments were swept (retention, "detail removed after 2 years"). */
  detailRemoved: boolean;
};

const PREFIX: Record<WatchMode, string> = { live: "live", replay: "replay", on_demand: "od" };
const zeroModes = <T>(make: () => T): Record<WatchMode, T> => ({ live: make(), replay: make(), on_demand: make() });
const num = (v: unknown) => Number(v ?? 0);
const round1 = (n: number) => Math.round(n * 10) / 10;
const ratio = (a: number, b: number) => (b > 0 ? a / b : 0);

const emptyMode = (): ModeRow => ({
  registered: 0,
  started: 0,
  attended: 0,
  watched15m: 0,
  watched30m: 0,
  watchedHalf: 0,
  watchedEnd: 0,
  viewers: 0,
  watchSec: 0,
  avgWatchMinutes: 0,
  pollResponses: 0,
  ctaShown: 0,
  ctaClicked: 0,
});

const emptySegment = (): SegmentRow => ({
  registrations: 0,
  modes: zeroModes(emptyMode),
  booked: 0,
  purchased: 0,
  converted: 0,
  revenueCents: 0,
  conversionRate: 0,
});

/** `anchor_at + <days>` as SQL. */
const until = (anchor: ReturnType<typeof sql>, days: number) => sql`${anchor} + make_interval(days => ${days}::int)`;

function modeAggregates(): ReturnType<typeof sql> {
  return sql.join(
    WATCH_MODES.map((m) => {
      const p = PREFIX[m];
      const c = (name: string) => sql.raw(`f.${p}_${name}`);
      return sql`count(*) filter (where f.registered_mode = ${m})::int as ${sql.raw(`${p}_registered`)},
        count(*) filter (where ${c("started")})::int as ${sql.raw(`${p}_started_n`)},
        count(*) filter (where ${c("attended")})::int as ${sql.raw(`${p}_attended_n`)},
        count(*) filter (where ${c("is_15m")})::int as ${sql.raw(`${p}_15m_n`)},
        count(*) filter (where ${c("is_30m")})::int as ${sql.raw(`${p}_30m_n`)},
        count(*) filter (where ${c("is_half")})::int as ${sql.raw(`${p}_half_n`)},
        count(*) filter (where ${c("is_end")})::int as ${sql.raw(`${p}_end_n`)},
        count(*) filter (where ${c("watched_sec")} > 0)::int as ${sql.raw(`${p}_viewers`)},
        coalesce(sum(${c("watched_sec")}), 0)::int as ${sql.raw(`${p}_watch_sec`)},
        coalesce(sum(${sql.raw(`f.poll_answers_${p}`)}), 0)::int as ${sql.raw(`${p}_polls`)}`;
    }),
    sql`, `,
  );
}

type SegmentSqlRow = Record<string, unknown> & { person_status: ReportSegment };

/** The segment table of rule 39 (registrations not cancelled). */
async function segmentRows(db: DbOrTx, webinarId: string, days: number): Promise<SegmentSqlRow[]> {
  const end = until(sql`f.anchor_at`, days);
  return rowsOf<SegmentSqlRow>(
    await db.execute(sql`select f.person_status::text as person_status, count(*)::int as registrations,
        ${modeAggregates()},
        count(*) filter (where c.first_booking_at <= ${end})::int as booked,
        count(*) filter (where c.first_paid_order_at <= ${end})::int as purchased,
        count(*) filter (where c.first_booking_at <= ${end} or c.first_paid_order_at <= ${end})::int as converted,
        coalesce(sum(rev.cents), 0)::bigint as revenue_cents
      from v_webinar_registration_facts f
      join v_webinar_conversions c on c.registration_id = f.registration_id
      left join lateral (select sum(o.total_cents) as cents from orders o
                         where o.person_id = f.person_id and o.status = 'paid'
                           and o.paid_at > f.anchor_at and o.paid_at <= ${end}) rev on true
      where f.webinar_id = ${webinarId}::uuid and f.status <> 'cancelled'
      group by 1`),
  );
}

/** Distinct persons shown or clicking a CTA, per segment and mode. */
async function ctaSegmentRows(db: DbOrTx, webinarId: string) {
  return rowsOf<{ person_status: ReportSegment; mode: WatchMode; shown: number; clicked: number }>(
    await db.execute(sql`select f.person_status::text as person_status, i.mode::text as mode,
        count(distinct f.registration_id::text || ':' || i.cta_id::text) filter (where i.kind = 'cta_shown')::int as shown,
        count(distinct f.registration_id::text || ':' || i.cta_id::text) filter (where i.kind = 'cta_clicked')::int as clicked
      from webinar_interactions i
      join webinar_registrations r on r.id = i.registration_id
      join persons p on p.id = r.person_id
      join v_webinar_registration_facts f on f.webinar_id = i.webinar_id and f.person_id = coalesce(p.merged_into_person_id, r.person_id)
      where i.webinar_id = ${webinarId}::uuid and i.kind in ('cta_shown', 'cta_clicked') and f.status <> 'cancelled'
      group by 1, 2`),
  );
}

function segmentOf(row: SegmentSqlRow | undefined): SegmentRow {
  const out = emptySegment();
  if (!row) return out;
  out.registrations = num(row.registrations);
  for (const m of WATCH_MODES) {
    const p = PREFIX[m];
    const g = (k: string) => num(row[`${p}_${k}`]);
    Object.assign(out.modes[m], {
      registered: g("registered"),
      started: g("started_n"),
      attended: g("attended_n"),
      watched15m: g("15m_n"),
      watched30m: g("30m_n"),
      watchedHalf: g("half_n"),
      watchedEnd: g("end_n"),
      viewers: g("viewers"),
      watchSec: g("watch_sec"),
      pollResponses: g("polls"),
    });
  }
  out.booked = num(row.booked);
  out.purchased = num(row.purchased);
  out.converted = num(row.converted);
  out.revenueCents = num(row.revenue_cents);
  return out;
}

function finish(s: SegmentRow): SegmentRow {
  for (const m of WATCH_MODES) s.modes[m].avgWatchMinutes = round1(ratio(s.modes[m].watchSec, s.modes[m].viewers) / 60);
  s.conversionRate = ratio(s.converted, s.registrations);
  return s;
}

function sumSegments(rows: SegmentRow[]): SegmentRow {
  const out = emptySegment();
  for (const r of rows) {
    out.registrations += r.registrations;
    out.booked += r.booked;
    out.purchased += r.purchased;
    out.converted += r.converted;
    out.revenueCents += r.revenueCents;
    for (const m of WATCH_MODES) {
      const a = out.modes[m];
      const b = r.modes[m];
      for (const k of Object.keys(a) as Array<keyof ModeRow>) if (k !== "avgWatchMinutes") a[k] += b[k];
    }
  }
  return finish(out);
}

/** Poll results per option per mode; a merged person's duplicate answers count once (the earliest). */
export async function getPollResults(db: DbOrTx, webinarId: string): Promise<PollResult[]> {
  const polls = rowsOf<{ id: string; key: string; question: LocalizedText; options: Array<{ key: string; label: LocalizedText }>; is_active: boolean; allow_multiple: boolean }>(
    await db.execute(sql`select id::text as id, key, question, options, is_active, allow_multiple from webinar_polls
      where webinar_id = ${webinarId}::uuid order by sort_order, created_at, id`),
  );
  if (!polls.length) return [];
  const counts = rowsOf<{ poll_id: string; mode: WatchMode; option_key: string | null; n: number }>(
    await db.execute(sql`with ans as (
        select distinct on (coalesce(p.merged_into_person_id, r.person_id), i.poll_id, i.mode) i.poll_id, i.mode, i.payload
        from webinar_interactions i
        join webinar_registrations r on r.id = i.registration_id
        join persons p on p.id = r.person_id
        where i.webinar_id = ${webinarId}::uuid and i.kind = 'poll_answer'
        order by coalesce(p.merged_into_person_id, r.person_id), i.poll_id, i.mode, i.occurred_at, i.id)
      select poll_id::text as poll_id, mode::text as mode, null::text as option_key, count(*)::int as n from ans group by 1, 2
      union all
      select poll_id::text, mode::text, k.option_key, count(*)::int
      from ans cross join lateral jsonb_array_elements_text(coalesce(ans.payload->'option_keys', '[]'::jsonb)) as k(option_key)
      group by 1, 2, 3`),
  );
  return polls.map((p) => {
    const mine = counts.filter((c) => c.poll_id === p.id);
    const respondents = zeroModes(() => 0);
    for (const c of mine) if (c.option_key === null) respondents[c.mode] = num(c.n);
    return {
      pollId: p.id,
      key: p.key,
      question: p.question,
      isActive: p.is_active,
      allowMultiple: p.allow_multiple,
      respondents,
      options: (p.options ?? []).map((o) => {
        const perMode = zeroModes(() => 0);
        for (const c of mine) if (c.option_key === o.key) perMode[c.mode] = num(c.n);
        return { key: o.key, label: o.label, counts: perMode };
      }),
    };
  });
}

/** The CTA table: shown, clicked and CTR per person, booked and purchased after the first click within the period. */
export async function getCtaResults(db: DbOrTx, webinarId: string, opts: { periodDays: number }): Promise<CtaResult[]> {
  const ctas = rowsOf<{ id: string; key: string; label: LocalizedText; url: string; is_active: boolean }>(
    await db.execute(sql`select id::text as id, key, label, url, is_active from webinar_ctas
      where webinar_id = ${webinarId}::uuid order by sort_order, created_at, id`),
  );
  if (!ctas.length) return [];
  const end = until(sql`fc.first_at`, opts.periodDays);
  const rows = rowsOf<{ cta_id: string; mode: WatchMode | null; shown: number; clicked: number; booked_after: number; purchased_after: number }>(
    await db.execute(sql`with ix as (
        select coalesce(p.merged_into_person_id, r.person_id) as person_id, i.cta_id, i.mode, i.kind, i.occurred_at
        from webinar_interactions i
        join webinar_registrations r on r.id = i.registration_id
        join persons p on p.id = r.person_id
        where i.webinar_id = ${webinarId}::uuid and i.kind in ('cta_shown', 'cta_clicked')),
      fc as (select person_id, cta_id, min(occurred_at) as first_at from ix where kind = 'cta_clicked' group by 1, 2)
      select cta_id::text as cta_id, mode::text as mode,
             count(distinct person_id) filter (where kind = 'cta_shown')::int as shown,
             count(distinct person_id) filter (where kind = 'cta_clicked')::int as clicked,
             0 as booked_after, 0 as purchased_after
      from ix group by 1, 2
      union all
      select fc.cta_id::text, null, 0, 0,
             count(*) filter (where exists (select 1 from bookings b where b.person_id = fc.person_id
                 and b.status in ('confirmed', 'attended') and b.created_at > fc.first_at and b.created_at <= ${end}))::int,
             count(*) filter (where exists (select 1 from orders o where o.person_id = fc.person_id
                 and o.status = 'paid' and o.paid_at > fc.first_at and o.paid_at <= ${end}))::int
      from fc group by 1`),
  );
  const persons = rowsOf<{ cta_id: string; shown: number; clicked: number }>(
    await db.execute(sql`select i.cta_id::text as cta_id,
        count(distinct coalesce(p.merged_into_person_id, r.person_id)) filter (where i.kind = 'cta_shown')::int as shown,
        count(distinct coalesce(p.merged_into_person_id, r.person_id)) filter (where i.kind = 'cta_clicked')::int as clicked
      from webinar_interactions i
      join webinar_registrations r on r.id = i.registration_id
      join persons p on p.id = r.person_id
      where i.webinar_id = ${webinarId}::uuid and i.kind in ('cta_shown', 'cta_clicked')
      group by 1`),
  );
  return ctas.map((c) => {
    const shown = zeroModes(() => 0);
    const clicked = zeroModes(() => 0);
    let bookedAfter = 0;
    let purchasedAfter = 0;
    for (const r of rows.filter((x) => x.cta_id === c.id)) {
      if (r.mode) {
        shown[r.mode] = num(r.shown);
        clicked[r.mode] = num(r.clicked);
      } else {
        bookedAfter = num(r.booked_after);
        purchasedAfter = num(r.purchased_after);
      }
    }
    const total = persons.find((p) => p.cta_id === c.id);
    const shownAll = num(total?.shown);
    return {
      ctaId: c.id,
      key: c.key,
      label: c.label,
      url: c.url,
      isActive: c.is_active,
      shown,
      clicked,
      ctr: shownAll > 0 ? num(total?.clicked) / shownAll : null,
      bookedAfter,
      purchasedAfter,
    };
  });
}

/** Registrations per UTM source and campaign, with attended (any mode) and converted in the period. */
async function utmRows(db: DbOrTx, webinarId: string, days: number): Promise<UtmRow[]> {
  const end = until(sql`f.anchor_at`, days);
  const rows = rowsOf<{ source: string | null; campaign: string | null; registrations: number; attended: number; converted: number }>(
    await db.execute(sql`select nullif(r.utm->>'source', '') as source, nullif(r.utm->>'campaign', '') as campaign,
        count(*)::int as registrations,
        count(*) filter (where f.live_attended or f.replay_attended or f.od_attended)::int as attended,
        count(*) filter (where c.first_booking_at <= ${end} or c.first_paid_order_at <= ${end})::int as converted
      from v_webinar_registration_facts f
      join webinar_registrations r on r.id = f.registration_id
      join v_webinar_conversions c on c.registration_id = f.registration_id
      where f.webinar_id = ${webinarId}::uuid and f.status <> 'cancelled'
      group by 1, 2
      order by 3 desc, 1 nulls last, 2 nulls last`),
  );
  return rows.map((r) => ({ source: r.source, campaign: r.campaign, registrations: num(r.registrations), attended: num(r.attended), converted: num(r.converted) }));
}

/** True when the webinar has registrations but no watch segments left after the two-year sweep. */
async function isDetailRemoved(db: DbOrTx, webinarId: string): Promise<boolean> {
  const [row] = rowsOf<{ removed: boolean }>(
    await db.execute(sql`select (w.live_ended_at is not null and w.live_ended_at < now() - interval '730 days'
        or w.mode = 'on_demand' and w.published_at < now() - interval '730 days')
        and exists (select 1 from webinar_registrations r where r.webinar_id = w.id)
        and not exists (select 1 from watch_segments s where s.webinar_id = w.id) as removed
      from webinars w where w.id = ${webinarId}::uuid`),
  );
  return row?.removed === true;
}

/** The report for any period of 1 to 365 days (the page's default is the webinar's own window). */
export async function buildWebinarReport(db: DbOrTx, webinarId: string, periodDays: number): Promise<WebinarReport> {
  const days = Math.max(1, Math.min(365, Math.trunc(periodDays)));
  const [segRows, ctaSeg, polls, ctas, utm, detailRemoved] = await Promise.all([
    segmentRows(db, webinarId, days),
    ctaSegmentRows(db, webinarId),
    getPollResults(db, webinarId),
    getCtaResults(db, webinarId, { periodDays: days }),
    utmRows(db, webinarId, days),
    isDetailRemoved(db, webinarId),
  ]);
  const bySegment = Object.fromEntries(REPORT_SEGMENTS.map((s) => [s, segmentOf(segRows.find((r) => r.person_status === s))])) as Record<ReportSegment, SegmentRow>;
  for (const c of ctaSeg) {
    const seg = bySegment[c.person_status];
    if (!seg) continue;
    seg.modes[c.mode].ctaShown = num(c.shown);
    seg.modes[c.mode].ctaClicked = num(c.clicked);
  }
  for (const s of REPORT_SEGMENTS) finish(bySegment[s]);
  const totals = sumSegments(REPORT_SEGMENTS.map((s) => bySegment[s]));
  return { totals, bySegment, byMode: totals.modes, polls, ctas, utm, periodDays: days, detailRemoved };
}

/** The report of rule 39 for one of the periods of rule 40. */
export function getWebinarReport(db: DbOrTx, webinarId: string, opts: { periodDays: ReportPeriod }): Promise<WebinarReport> {
  return buildWebinarReport(db, webinarId, opts.periodDays);
}

// ---------------------------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------------------------

/** One RFC 4180 cell; a leading `=`, `+`, `-` or `@` is prefixed with `'` so a spreadsheet never runs it. */
export function csvCell(v: string | number | boolean | null | undefined): string {
  if (v === null || v === undefined) return "";
  let text = typeof v === "boolean" ? (v ? "yes" : "no") : String(v);
  if (typeof v === "string" && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const csvLine = (cells: ReadonlyArray<string | number | boolean | null | undefined>) => cells.map(csvCell).join(",");

const MODE_METRICS: Array<[keyof ModeRow, string]> = [
  ["registered", "registered"],
  ["started", "started"],
  ["attended", "attended"],
  ["watched15m", "watched_15m"],
  ["watched30m", "watched_30m"],
  ["watchedHalf", "watched_50pct"],
  ["watchedEnd", "watched_end"],
  ["avgWatchMinutes", "avg_watch_min"],
  ["pollResponses", "poll_responses"],
  ["ctaShown", "cta_shown"],
  ["ctaClicked", "cta_clicked"],
];

const pct = (r: number | null) => (r === null ? "" : (Math.round(r * 1000) / 10).toFixed(1));

/**
 * The aggregate report as CSV (rule 41: no personal data). Four tables separated by a blank line:
 * segments (lead, customer, member, total, one column per mode and metric), polls (one line per
 * option), CTAs and UTM. Texts are in `locale` (falling back to any locale present).
 */
export function buildReportCsv(report: WebinarReport, locale: string = "en"): string {
  const text = (t: LocalizedText | null | undefined) => (t ? (t[locale as keyof LocalizedText] ?? Object.values(t).find(Boolean) ?? "") : "");
  const lines: string[] = [];
  const segHeader = ["segment", "registrations", ...WATCH_MODES.flatMap((m) => MODE_METRICS.map(([, name]) => `${PREFIX[m]}_${name}`)), "booked", "purchased", "converted", "conversion_rate_pct", "revenue_cents", "period_days"];
  lines.push(csvLine(segHeader));
  const seg = (name: string, s: SegmentRow) =>
    csvLine([name, s.registrations, ...WATCH_MODES.flatMap((m) => MODE_METRICS.map(([k]) => s.modes[m][k])), s.booked, s.purchased, s.converted, pct(s.conversionRate), s.revenueCents, report.periodDays]);
  for (const s of REPORT_SEGMENTS) lines.push(seg(s, report.bySegment[s]));
  lines.push(seg("total", report.totals));

  lines.push("");
  lines.push(csvLine(["poll_key", "question", "option_key", "option", ...WATCH_MODES.map((m) => `${PREFIX[m]}_answers`)]));
  for (const p of report.polls) {
    for (const o of p.options) lines.push(csvLine([p.key, text(p.question), o.key, text(o.label), ...WATCH_MODES.map((m) => o.counts[m])]));
  }

  lines.push("");
  lines.push(csvLine(["cta_key", "label", ...WATCH_MODES.flatMap((m) => [`${PREFIX[m]}_shown`, `${PREFIX[m]}_clicked`]), "ctr_pct", "booked_after", "purchased_after"]));
  for (const c of report.ctas) {
    lines.push(csvLine([c.key, text(c.label), ...WATCH_MODES.flatMap((m) => [c.shown[m], c.clicked[m]]), pct(c.ctr), c.bookedAfter, c.purchasedAfter]));
  }

  lines.push("");
  lines.push(csvLine(["utm_source", "utm_campaign", "registrations", "attended", "converted"]));
  for (const u of report.utm) lines.push(csvLine([u.source, u.campaign, u.registrations, u.attended, u.converted]));
  return lines.join("\r\n") + "\r\n";
}

// ---------------------------------------------------------------------------------------------
// Registrant export (rule 41, `persons.export`)
// ---------------------------------------------------------------------------------------------

export type RegistrantExportRow = {
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  status: "registered" | "cancelled" | "blocked";
  personStatus: ReportSegment;
  registeredMode: WatchMode;
  source: string;
  locale: string;
  registeredAt: Date;
  utmSource: string | null;
  utmCampaign: string | null;
  modes: Record<WatchMode, { started: boolean; watchedSec: number; attended: boolean; is15m: boolean; is30m: boolean; isHalf: boolean; isEnd: boolean; pollAnswers: number; ctaClicks: number }>;
  questions: number;
  chats: number;
};

/** One row per registration of a resolved person (the facts view), oldest first. */
export async function listRegistrantExportRows(db: DbOrTx, webinarId: string): Promise<RegistrantExportRow[]> {
  const rows = rowsOf<Record<string, unknown>>(
    await db.execute(sql`select f.*, p.first_name, p.last_name, p.email, r.source::text as source, r.locale::text as locale, r.utm
      from v_webinar_registration_facts f
      join webinar_registrations r on r.id = f.registration_id
      join persons p on p.id = f.person_id
      where f.webinar_id = ${webinarId}::uuid
      order by f.registered_at, f.registration_id`),
  );
  return rows.map((x) => {
    const utm = (x.utm ?? {}) as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === "string" && v ? v : null);
    const modes = zeroModes(() => ({ started: false, watchedSec: 0, attended: false, is15m: false, is30m: false, isHalf: false, isEnd: false, pollAnswers: 0, ctaClicks: 0 }));
    for (const m of WATCH_MODES) {
      const p = PREFIX[m];
      modes[m] = {
        started: x[`${p}_started`] === true,
        watchedSec: num(x[`${p}_watched_sec`]),
        attended: x[`${p}_attended`] === true,
        is15m: x[`${p}_is_15m`] === true,
        is30m: x[`${p}_is_30m`] === true,
        isHalf: x[`${p}_is_half`] === true,
        isEnd: x[`${p}_is_end`] === true,
        pollAnswers: num(x[`poll_answers_${p}`]),
        ctaClicks: num(x[`cta_clicks_${p}`]),
      };
    }
    return {
      firstName: str(x.first_name),
      lastName: str(x.last_name),
      email: str(x.email),
      status: x.status as RegistrantExportRow["status"],
      personStatus: x.person_status as ReportSegment,
      registeredMode: x.registered_mode as WatchMode,
      source: String(x.source),
      locale: String(x.locale),
      registeredAt: x.registered_at instanceof Date ? x.registered_at : new Date(String(x.registered_at)),
      utmSource: str(utm.source),
      utmCampaign: str(utm.campaign),
      modes,
      questions: num(x.questions),
      chats: num(x.chats),
    };
  });
}

/** The registrant CSV (name, email, status, per-mode facts); personal data, behind `persons.export`. */
export function buildRegistrantsCsv(rows: readonly RegistrantExportRow[]): string {
  const perMode = ["started", "watched_min", "attended", "watched_15m", "watched_30m", "watched_50pct", "watched_end", "poll_answers", "cta_clicks"];
  const header = [
    "first_name",
    "last_name",
    "email",
    "status",
    "person_status",
    "registered_mode",
    "source",
    "locale",
    "registered_at",
    "utm_source",
    "utm_campaign",
    ...WATCH_MODES.flatMap((m) => perMode.map((k) => `${PREFIX[m]}_${k}`)),
    "questions",
    "chats",
  ];
  const lines = rows.map((r) =>
    csvLine([
      r.firstName,
      r.lastName,
      r.email,
      r.status,
      r.personStatus,
      r.registeredMode,
      r.source,
      r.locale,
      r.registeredAt.toISOString(),
      r.utmSource,
      r.utmCampaign,
      ...WATCH_MODES.flatMap((m) => {
        const f = r.modes[m];
        return [f.started, round1(f.watchedSec / 60), f.attended, f.is15m, f.is30m, f.isHalf, f.isEnd, f.pollAnswers, f.ctaClicks];
      }),
      r.questions,
      r.chats,
    ]),
  );
  return [csvLine(header), ...lines].join("\r\n") + "\r\n";
}

// ---------------------------------------------------------------------------------------------
// Ops-facing stats (section 4.7: the person card, the action dashboard and the daily digest)
// ---------------------------------------------------------------------------------------------

export type PersonWebinarStatsRow = {
  webinarsRegistered: number;
  webinarsAttendedLive: number;
  replaysWatched: number;
  onDemandWatched: number;
  watchSecTotal: number;
  pollAnswers: number;
  ctaClicks: number;
  lastRegisteredAt: Date | null;
  lastAttendedAt: Date | null;
};

const asDate = (v: unknown): Date | null => (v === null || v === undefined ? null : v instanceof Date ? v : new Date(String(v)));

/**
 * `v_person_webinar_stats` of the person (resolved through `merged_into_person_id`, so a merged
 * loser's id answers with the winner's row). Native counts; the two `last_*` dates also consider
 * the old tool's imported history. A person without webinar history gets zeros.
 */
export async function personWebinarStats(db: DbOrTx, personId: string): Promise<PersonWebinarStatsRow> {
  const [row] = rowsOf<Record<string, unknown>>(
    await db.execute(sql`select s.* from v_person_webinar_stats s
      where s.person_id = (select coalesce(p.merged_into_person_id, p.id) from persons p where p.id = ${personId}::uuid)`),
  );
  return {
    webinarsRegistered: num(row?.webinars_registered),
    webinarsAttendedLive: num(row?.webinars_attended_live),
    replaysWatched: num(row?.replays_watched),
    onDemandWatched: num(row?.on_demand_watched),
    watchSecTotal: num(row?.watch_sec_total),
    pollAnswers: num(row?.poll_answers),
    ctaClicks: num(row?.cta_clicks),
    lastRegisteredAt: asDate(row?.last_webinar_registered_at),
    lastAttendedAt: asDate(row?.last_webinar_attended_at),
  };
}

/**
 * The one definition of "webinar leads have not booked" (blueprint 23, decision 39): registrations
 * (not cancelled, one per resolved person and webinar) with snapshot `lead`, of a webinar that is
 * not a draft or cancelled and that started between `startedSince` and now (an on-demand webinar:
 * the registration in that window), whose person has no `bookings` row created after the
 * registration.
 */
const leadsWithoutBookingWhere = (startedSince: Date) => sql`f.person_status = 'lead' and f.status <> 'cancelled'
  and w.status not in ('draft', 'cancelled')
  and coalesce(w.starts_at, f.registered_at) > ${startedSince}
  and coalesce(w.starts_at, f.registered_at) <= now()
  and not exists (select 1 from bookings b where b.person_id = f.person_id and b.created_at > f.registered_at)`;

export async function countLeadsWithoutBooking(db: DbOrTx, input: { startedSince: Date }): Promise<number> {
  const [row] = rowsOf<{ n: number }>(
    await db.execute(sql`select count(*)::int as n from v_webinar_registration_facts f join webinars w on w.id = f.webinar_id
      where ${leadsWithoutBookingWhere(input.startedSince)}`),
  );
  return num(row?.n);
}

export async function listLeadsWithoutBooking(
  db: DbOrTx,
  input: { startedSince: Date; limit: number },
): Promise<Array<{ personId: string; webinarId: string; registeredAt: Date }>> {
  const limit = Math.max(1, Math.min(1000, Math.trunc(input.limit)));
  const rows = rowsOf<{ person_id: string; webinar_id: string; registered_at: unknown }>(
    await db.execute(sql`select f.person_id::text as person_id, f.webinar_id::text as webinar_id, f.registered_at
      from v_webinar_registration_facts f join webinars w on w.id = f.webinar_id
      where ${leadsWithoutBookingWhere(input.startedSince)}
      order by f.registered_at desc, f.registration_id
      limit ${limit}`),
  );
  return rows.map((r) => ({ personId: r.person_id, webinarId: r.webinar_id, registeredAt: asDate(r.registered_at)! }));
}

export type WebinarHealthRow = {
  webinarId: string;
  title: string;
  startsAt: Date;
  mode: "live" | "simulive" | "on_demand";
  youtubeLifecycle: string | null;
  broadcastError: string | null;
  registrations: number;
};

/**
 * The ops daily digest (rule 43): live and simulive webinars starting in the next `hours` (and
 * those live now) that are published, live, or a live draft whose publishing is pending or
 * failed, with their broadcast state and `registered` count. The title is in the spoken language.
 */
export async function upcomingWebinarHealth(db: DbOrTx, within: { hours: number }): Promise<WebinarHealthRow[]> {
  const rows = rowsOf<{
    id: string;
    title: Record<string, string>;
    spoken_locale: string;
    slug: string;
    starts_at: unknown;
    mode: WebinarHealthRow["mode"];
    youtube_lifecycle: string | null;
    broadcast_error: string | null;
    registrations: number;
  }>(
    await db.execute(sql`select w.id::text as id, w.title, w.spoken_locale::text as spoken_locale, w.slug, w.starts_at, w.mode::text as mode,
        w.youtube_lifecycle, w.broadcast_error,
        (select count(*)::int from webinar_registrations r where r.webinar_id = w.id and r.status = 'registered') as registrations
      from webinars w
      where w.mode in ('live', 'simulive') and w.starts_at is not null
        and (w.status = 'live'
             or ((w.status = 'published' or (w.status = 'draft' and w.mode = 'live' and (w.publish_requested_at is not null or w.broadcast_error is not null)))
                 and w.starts_at > now() and w.starts_at <= now() + make_interval(hours => ${Math.trunc(within.hours)}::int)))
      order by w.starts_at, w.id`),
  );
  return rows.map((r) => ({
    webinarId: r.id,
    title: r.title?.[r.spoken_locale] || Object.values(r.title ?? {}).find(Boolean) || r.slug,
    startsAt: asDate(r.starts_at)!,
    mode: r.mode,
    youtubeLifecycle: r.youtube_lifecycle,
    broadcastError: r.broadcast_error,
    registrations: num(r.registrations),
  }));
}
