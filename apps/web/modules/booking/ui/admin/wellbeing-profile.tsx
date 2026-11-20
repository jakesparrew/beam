/**
 * The wellbeing profile on the staff person page: the guest's check-ins over 60 days as four lines
 * (energy, sleep, calm, mood), for each score whether the last 14 days went up or down against
 * the 46 days before, the average change a visit brings, and visits and hours. The guest's notes
 * stay private (never shown here). Shown to staff with `persons.sensitive_read` only.
 */
import type { WellbeingJourney } from "../../api";

type Tr = (key: string, params?: Record<string, string | number>) => string;
const KEYS = ["energy", "sleep", "calm", "mood"] as const;
type Key = (typeof KEYS)[number];
const COLOR: Record<Key, string> = { energy: "#d1a64a", sleep: "#8a86b8", calm: "#6f8f7a", mood: "#c0714f" };
const DAY = 86_400_000;

function average(values: number[]): number | null {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

export function WellbeingProfile({ journey, tr, now = new Date() }: { journey: WellbeingJourney; tr: Tr; now?: Date }) {
  // Before-visit check-ins describe the arrival state; the profile follows daily and after ones.
  const points = journey.checkins.filter((c) => c.moment !== "before");
  const W = 640;
  const H = 180;
  const start = now.getTime() - 60 * DAY;
  const x = (onDate: string) => 36 + ((new Date(`${onDate}T12:00:00Z`).getTime() - start) / (60 * DAY)) * (W - 48);
  const y = (v: number) => H - 22 - ((v - 1) / 4) * (H - 40);
  const recentFrom = new Date(now.getTime() - 14 * DAY).toISOString().slice(0, 10);
  const trend = (k: Key) => {
    const vals = (from: (d: string) => boolean) => points.filter((p) => from(p.onDate) && p[k] != null).map((p) => p[k] as number);
    const recent = average(vals((d) => d >= recentFrom));
    const before = average(vals((d) => d < recentFrom));
    return { recent, delta: recent != null && before != null ? Math.round((recent - before) * 10) / 10 : null };
  };
  const months = [0, 30, 60].map((d) => new Date(start + d * DAY));
  const signed = (n: number) => `${n > 0 ? "+" : ""}${n.toFixed(1).replace(".", ",")}`;

  return (
    <section className="grid gap-5 rounded-[1.25rem] bg-card p-5 shadow-[0_1px_2px_rgb(33_40_66/0.04),0_12px_32px_-18px_rgb(33_40_66/0.22)] sm:p-6" aria-labelledby="wellbeing-heading" data-testid="panel-wellbeing">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="wellbeing-heading" className="text-lg font-semibold">
          {tr("site.portal.wellbeing.staff.title")}
        </h2>
        <p className="text-xs text-muted-foreground">
          {tr("site.portal.wellbeing.staff.summary", { checkins: journey.checkins.length, visits: journey.visits, hours: journey.hours })}
        </p>
      </div>

      {points.length < 2 ? (
        <p className="text-sm text-muted-foreground">{tr("site.portal.wellbeing.staff.empty")}</p>
      ) : (
        <>
          <ul className="grid gap-3 sm:grid-cols-4">
            {KEYS.map((k) => {
              const t = trend(k);
              const up = (t.delta ?? 0) > 0.2;
              const down = (t.delta ?? 0) < -0.2;
              return (
                <li key={k} className="grid gap-1 rounded-2xl border border-border p-3">
                  <span className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span className="size-2 rounded-full" style={{ background: COLOR[k] }} />
                    {tr(`site.portal.wellbeing.scale.${k}`)}
                  </span>
                  <span className="text-2xl font-semibold tabular-nums">{t.recent != null ? t.recent.toFixed(1).replace(".", ",") : "–"}</span>
                  <span className={`text-xs font-medium ${up ? "text-[#2f6d44]" : down ? "text-[#a03d2a]" : "text-muted-foreground"}`}>
                    {t.delta == null ? "–" : `${up ? "▲" : down ? "▼" : "▬"} ${signed(t.delta)} ${tr("site.portal.wellbeing.staff.vsBefore")}`}
                  </span>
                </li>
              );
            })}
          </ul>
          <figure className="grid gap-2">
            <svg viewBox={`0 0 ${W} ${H}`} className="h-48 w-full" role="img" aria-label={tr("site.portal.wellbeing.staff.chart")}>
              {[1, 2, 3, 4, 5].map((v) => (
                <g key={v}>
                  <line x1="36" x2={W - 12} y1={y(v)} y2={y(v)} stroke="currentColor" strokeOpacity={v === 3 ? 0.12 : 0.06} />
                  <text x="22" y={y(v) + 4} fontSize="10" textAnchor="end" fill="currentColor" opacity="0.45">
                    {v}
                  </text>
                </g>
              ))}
              {months.map((m, i) => (
                <text key={i} x={36 + (i / 2) * (W - 48)} y={H - 4} fontSize="10" textAnchor={i === 0 ? "start" : i === 2 ? "end" : "middle"} fill="currentColor" opacity="0.45">
                  {m.toLocaleDateString("nl-BE", { day: "numeric", month: "short" })}
                </text>
              ))}
              {KEYS.map((k) => {
                const raw = points.filter((p) => p[k] != null);
                if (raw.length < 2) return null;
                // A 7-day moving average shows the waves (better, worse) instead of every single answer.
                const ps = raw.map((p) => {
                  const t = new Date(`${p.onDate}T12:00:00Z`).getTime();
                  const win = raw.filter((q) => {
                    const u = new Date(`${q.onDate}T12:00:00Z`).getTime();
                    return u <= t && u > t - 7 * DAY;
                  });
                  return { onDate: p.onDate, v: average(win.map((q) => q[k] as number))! };
                });
                const d = ps.map((p, i) => `${i ? "L" : "M"}${x(p.onDate).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ");
                return <path key={k} d={d} fill="none" stroke={COLOR[k]} strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" opacity="0.9" />;
              })}
            </svg>
          </figure>
        </>
      )}

      {journey.visitEffect ? (
        <p className="rounded-2xl bg-[#f6efdf] p-3 text-sm">
          <span className="font-semibold">{tr("site.portal.wellbeing.effectTitle", { count: journey.visitEffect.visits })}:</span>{" "}
          {(["energy", "calm", "mood"] as const).map((k) => `${signed(journey.visitEffect![k])} ${tr(`site.portal.wellbeing.scale.${k}`).toLowerCase()}`).join(" · ")}
        </p>
      ) : null}
      <p className="text-xs text-muted-foreground">🔒 {tr("site.portal.wellbeing.staff.privacy")}</p>
    </section>
  );
}
