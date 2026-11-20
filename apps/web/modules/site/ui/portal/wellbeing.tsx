/**
 * Wellbeing on the portal home: the check-in card (before or after a visit, or the daily one; a
 * plain form, each score a row of five tappable choices) and the journey card (visits, hours,
 * the average change a visit brings, a 60-day trend of energy and calm, and the next milestone).
 * Data comes from `booking.getWellbeingJourney`; the form posts the page's server action.
 */
import type { Locale } from "@beam/core/i18n";
import type { CheckinPrompt, WellbeingJourney } from "@/modules/booking/api";
import type { Tr } from "./cards/bookings-card";
import { CheckinFlow, type CheckinQuestion } from "./checkin-flow";

const MOOD_ICONS = ["🌧", "🌫", "☁", "🌤", "☀"];
const SLEEP_ICONS = ["🌑", "🌘", "🌗", "🌖", "🌕"];

/** The questions of a check-in, in order (no sleep question right after a visit). */
function questionsFor(moment: "before" | "after" | "daily", tr: Tr): CheckinQuestion[] {
  const five = (key: string, icons?: string[]) =>
    [1, 2, 3, 4, 5].map((v) => ({ value: v, label: tr(`site.portal.wellbeing.q.${key}.o${v}`), ...(icons ? { icon: icons[v - 1] } : {}) }));
  const qs: CheckinQuestion[] = [
    { name: "energy", style: "scale", title: tr(`site.portal.wellbeing.q.energy.${moment === "after" ? "titleAfter" : "title"}`), options: five("energy") },
    { name: "sleep", style: "cards", title: tr("site.portal.wellbeing.q.sleep.title"), options: five("sleep", SLEEP_ICONS) },
    { name: "calm", style: "words", title: tr("site.portal.wellbeing.q.calm.title"), hint: tr("site.portal.wellbeing.q.calm.hint"), options: five("calm") },
    { name: "mood", style: "cards", title: tr("site.portal.wellbeing.q.mood.title"), options: five("mood", MOOD_ICONS) },
  ];
  return moment === "after" ? qs.filter((q) => q.name !== "sleep") : qs;
}

export function CheckinCard({ prompt, action, saved, locale, tr }: { prompt: CheckinPrompt | null; action: (fd: FormData) => Promise<void>; saved: boolean; locale: Locale; tr: Tr }) {
  if (saved) {
    return (
      <section className="grid place-items-center gap-2 rounded-[1.5rem] bg-[#e7f1ea] p-6 text-center" role="status">
        <span aria-hidden="true" className="text-3xl">
          🌿
        </span>
        <p className="font-semibold text-[#2f6d44]">{tr("site.portal.wellbeing.saved")}</p>
        <p className="text-sm text-[#2f6d44]/80">{tr("site.portal.wellbeing.savedBody")}</p>
      </section>
    );
  }
  if (!prompt) return null;
  const when =
    prompt.moment === "daily"
      ? null
      : new Intl.DateTimeFormat(locale, { timeZone: "Europe/Brussels", weekday: "long", hour: "2-digit", minute: "2-digit" }).format(prompt.startsAt);
  return (
    <CheckinFlow
      moment={prompt.moment}
      bookingId={prompt.moment === "daily" ? null : prompt.bookingId}
      questions={questionsFor(prompt.moment, tr)}
      action={action}
      labels={{
        eyebrow: tr("site.portal.wellbeing.eyebrow"),
        title: tr(`site.portal.wellbeing.title.${prompt.moment}`),
        intro: when ? tr("site.portal.wellbeing.forVisit", { when }) : tr("site.portal.wellbeing.dailyIntro"),
        back: tr("site.portal.wellbeing.back"),
        step: tr("site.portal.wellbeing.start"),
        noteTitle: tr(`site.portal.wellbeing.q.note.${prompt.moment}`),
        notePlaceholder: tr("site.portal.wellbeing.notePlaceholder"),
        chips: [1, 2, 3, 4].map((n) => tr(`site.portal.wellbeing.q.note.chips.${prompt.moment}${n}`)),
        skip: tr("site.portal.wellbeing.finish"),
        save: tr("site.portal.wellbeing.save"),
        private: tr("site.portal.wellbeing.private"),
      }}
    />
  );
}

/** A small two-line SVG chart (energy gold, calm sage) over the dated check-ins. */
function Trend({ points, labels }: { points: { onDate: string; energy: number; calm: number }[]; labels: { energy: string; calm: string } }) {
  if (points.length < 2) return null;
  const W = 320;
  const H = 96;
  const x = (i: number) => 8 + (i * (W - 16)) / (points.length - 1);
  const y = (v: number) => H - 10 - ((v - 1) / 4) * (H - 20);
  const path = (k: "energy" | "calm") => points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p[k]).toFixed(1)}`).join(" ");
  return (
    <figure className="grid gap-2">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-24 w-full" role="img" aria-label={`${labels.energy}, ${labels.calm}`}>
        {[1, 3, 5].map((v) => (
          <line key={v} x1="0" x2={W} y1={y(v)} y2={y(v)} stroke="currentColor" strokeOpacity="0.08" />
        ))}
        <path d={path("calm")} fill="none" stroke="#6f8f7a" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
        <path d={path("energy")} fill="none" stroke="#d1a64a" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <figcaption className="flex gap-4 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span className="size-2 rounded-full bg-[#d1a64a]" />
          {labels.energy}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-2 rounded-full bg-[#6f8f7a]" />
          {labels.calm}
        </span>
      </figcaption>
    </figure>
  );
}

const MILESTONES = [1, 5, 10, 25, 50, 100];

export function JourneyCard({ journey, tr }: { journey: WellbeingJourney; tr: Tr }) {
  const next = MILESTONES.find((m) => m > journey.visits) ?? null;
  const prev = [...MILESTONES].reverse().find((m) => m <= journey.visits) ?? 0;
  const pct = next ? Math.round(((journey.visits - prev) / (next - prev)) * 100) : 100;
  const signed = (n: number) => `${n > 0 ? "+" : ""}${n.toLocaleString("nl-BE")}`;
  const points = journey.checkins.filter((c) => c.moment !== "before");
  return (
    <section aria-labelledby="journey-title" className="grid gap-6 rounded-[1.5rem] bg-[#212842] p-6 text-[#fffaef] sm:p-8">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="journey-title" className="font-display text-2xl">
          {tr("site.portal.wellbeing.journey")}
        </h2>
        {journey.firstVisitOn ? <p className="text-xs text-[#fffaef]/60">{tr("site.portal.wellbeing.since", { date: journey.firstVisitOn.split("-").reverse().join("/") })}</p> : null}
      </div>
      <dl className="grid grid-cols-3 gap-3">
        {(
          [
            ["visits", journey.visits],
            ["hours", journey.hours],
            ["nights", journey.nights],
          ] as const
        ).map(([k, v]) => (
          <div key={k} className="rounded-2xl bg-[#fffaef]/[0.06] p-4 ring-1 ring-[#fffaef]/10">
            <dt className="text-xs text-[#fffaef]/60">{tr(`site.portal.wellbeing.stat.${k}`)}</dt>
            <dd className="mt-1 text-3xl font-semibold tabular-nums">{v}</dd>
          </div>
        ))}
      </dl>
      {journey.visitEffect ? (
        <div className="rounded-2xl bg-[#e8c26a]/10 p-4 ring-1 ring-[#e8c26a]/25">
          <p className="text-xs font-semibold tracking-[0.2em] text-[#e8c26a] uppercase">{tr("site.portal.wellbeing.effectTitle", { count: journey.visitEffect.visits })}</p>
          <ul className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-lg font-semibold">
            {(["energy", "calm", "mood"] as const).map((k) => (
              <li key={k}>
                <span className="tabular-nums">{signed(journey.visitEffect![k])}</span> <span className="text-sm font-normal text-[#fffaef]/70">{tr(`site.portal.wellbeing.scale.${k}`).toLowerCase()}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="text-sm text-[#fffaef]/70">{tr("site.portal.wellbeing.effectEmpty")}</p>
      )}
      <div className="rounded-2xl bg-[#fffaef] p-4 text-[#212842]">
        <p className="mb-2 text-xs font-semibold tracking-[0.2em] text-[#a0621e] uppercase">{tr("site.portal.wellbeing.trend")}</p>
        {points.length >= 2 ? (
          <Trend points={points} labels={{ energy: tr("site.portal.wellbeing.scale.energy"), calm: tr("site.portal.wellbeing.scale.calm") }} />
        ) : (
          <p className="text-sm text-muted-foreground">{tr("site.portal.wellbeing.trendEmpty")}</p>
        )}
      </div>
      {next ? (
        <div className="grid gap-2">
          <div className="flex justify-between text-sm">
            <span>{tr("site.portal.wellbeing.milestone", { count: next })}</span>
            <span className="text-[#fffaef]/60 tabular-nums">
              {journey.visits}/{next}
            </span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-[#fffaef]/10">
            <div className="h-full rounded-full bg-[linear-gradient(90deg,#b57627,#f7cc78)]" style={{ width: `${Math.max(pct, 4)}%` }} />
          </div>
        </div>
      ) : null}
    </section>
  );
}
