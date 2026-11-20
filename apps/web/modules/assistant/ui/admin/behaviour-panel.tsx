/**
 * "Behaviour and advice" on the staff person page: how the person books (visits, rhythm,
 * preference, reliability, credit, spend, newsletter consent), the signals the rules derive from
 * it, and the lead agent's advice: who this is, and up to three next steps, each with its reason
 * and a button to carry it out. Only booking, credit and purchase facts; no wellbeing data.
 */
import type { BehaviourFacts, ProfileAdvice } from "../../api";
import { AskAgent, ApplyStep } from "./behaviour-controls";
import { SURFACE } from "./parts";

type Tr = (key: string, params?: Record<string, string | number>) => string;

const SIGNAL_TONE: Record<string, string> = {
  loyal: "bg-[#e7f1ea] text-[#2f6d44]",
  regular: "bg-[#e7f1ea] text-[#2f6d44]",
  has_upcoming: "bg-[#e7f1ea] text-[#2f6d44]",
  lapsing: "bg-[#fdf0dc] text-[#a0621e]",
  credits_expiring: "bg-[#fdf0dc] text-[#a0621e]",
  credits_unused: "bg-[#fdf0dc] text-[#a0621e]",
  lost: "bg-[#fdecea] text-[#b42318]",
  no_show_risk: "bg-[#fdecea] text-[#b42318]",
};

export function BehaviourPanel({
  personId,
  facts,
  advice,
  canApply,
  tr,
  formatDate,
  formatDateTime,
}: {
  personId: string;
  facts: BehaviourFacts;
  advice: { actionId: string; at: Date; advice: ProfileAdvice } | null;
  canApply: boolean;
  tr: Tr;
  formatDate: (isoDay: string) => string;
  formatDateTime: (d: Date) => string;
}) {
  const t = (k: string, p?: Record<string, string | number>) => tr(`assistant.admin.behaviour.${k}`, p);
  const preference = [
    facts.favouriteKind ? t(`kind.${facts.favouriteKind}`) : null,
    facts.favouriteWeekday ? t(`weekday.${facts.favouriteWeekday}`) : null,
    facts.favouriteDaypart ? t(`daypart.${facts.favouriteDaypart}`) : null,
  ].filter(Boolean);
  const tiles: { label: string; value: string; hint?: string }[] = [
    { label: t("visits"), value: String(facts.visits), hint: t("visits90", { n: facts.visits90 }) },
    { label: t("lastVisit"), value: facts.daysSinceLastVisit == null ? t("never") : t("daysAgo", { count: facts.daysSinceLastVisit }), ...(facts.lastVisitOn ? { hint: formatDate(facts.lastVisitOn) } : {}) },
    { label: t("rhythm"), value: facts.rhythmDays ? t("rhythmValue", { days: facts.rhythmDays }) : "–", ...(facts.leadTimeDays != null ? { hint: t("leadTime", { days: facts.leadTimeDays }) } : {}) },
    { label: t("preference"), value: preference.length ? preference.join(" · ") : "–" },
    { label: t("next"), value: facts.nextBookingOn ? formatDate(facts.nextBookingOn) : t("none") },
    { label: t("reliability"), value: String(facts.noShows + facts.lateCancellations) },
    { label: t("credits"), value: facts.credits.length ? facts.credits.map((c) => `${c.remaining} × ${t(`kind.${c.kind === "night" ? "night" : "day"}`)}`).join(", ") : t("none"), ...(facts.credits.find((c) => c.expiresOn) ? { hint: `→ ${formatDate(facts.credits.find((c) => c.expiresOn)!.expiresOn!)}` } : {}) },
    { label: t("spend"), value: `€ ${facts.spendEuro.toLocaleString("nl-BE")}`, hint: t("orders", { count: facts.paidOrders }) },
  ];
  const a = advice?.advice ?? null;

  return (
    <section className={`${SURFACE} grid gap-5 p-5 sm:p-6`} aria-labelledby="behaviour-h" data-testid="panel-behaviour">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="behaviour-h" className="text-lg font-semibold">
          {t("title")}
        </h2>
        <span className={`rounded-full px-3 py-1 text-xs font-medium ${facts.newsletter ? "bg-[#e7f1ea] text-[#2f6d44]" : "bg-muted text-muted-foreground"}`}>
          {t("newsletter")}: {t(facts.newsletter ? "yes" : "no")}
        </span>
      </div>

      <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {tiles.map((x) => (
          <div key={x.label} className="grid content-start gap-0.5 rounded-2xl border p-3">
            <dt className="text-xs text-muted-foreground">{x.label}</dt>
            <dd className="text-base font-semibold">{x.value}</dd>
            {x.hint ? <dd className="text-xs text-muted-foreground">{x.hint}</dd> : null}
          </div>
        ))}
      </dl>

      {facts.signals.length ? (
        <ul className="flex flex-wrap gap-1.5">
          {facts.signals.map((s) => (
            <li key={s} className={`rounded-full px-2.5 py-1 text-xs font-medium ${SIGNAL_TONE[s] ?? "bg-muted text-muted-foreground"}`}>
              {t(`signal.${s}`)}
            </li>
          ))}
        </ul>
      ) : null}

      <div className="grid gap-3 rounded-2xl bg-[#212842] p-4 text-[#fffaef] sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs font-semibold tracking-[0.2em] text-[#e8c26a] uppercase">{t("advice.title")}</p>
          <span className="flex items-center gap-3">
            {advice ? <span className="text-xs text-[#fffaef]/55">{formatDateTime(advice.at)}</span> : null}
            <span className="[&_button]:bg-[#fffaef] [&_button]:text-[#212842] [&_span]:text-[#fffaef]/70">
              <AskAgent personId={personId} label={t(advice ? "advice.again" : "advice.analyse")} queuedLabel={t("advice.queued")} />
            </span>
          </span>
        </div>
        {!a ? (
          <p className="text-sm text-[#fffaef]/75">{t("advice.none")}</p>
        ) : (
          <>
            <div>
              <p className="font-display text-2xl">{a.persona}</p>
              <p className="mt-1 max-w-3xl text-sm text-[#fffaef]/80">{a.summary}</p>
            </div>
            {a.recommendations.length === 0 ? (
              <p className="text-sm text-[#fffaef]/75">{t("advice.empty")}</p>
            ) : (
              <ol className="grid gap-2">
                {a.recommendations.map((r, i) => (
                  <li key={i} className="grid gap-2 rounded-xl bg-[#fffaef] p-3.5 text-[#212842] sm:grid-cols-[1fr_auto] sm:items-center">
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-2 text-sm font-semibold">
                        <span className="rounded-full bg-[#f3e7cc] px-2 py-0.5 text-[11px] font-semibold tracking-wide text-[#7a4a12] uppercase">{t(`advice.type.${r.type}`)}</span>
                        {r.title}
                        {r.flow ? <code className="text-xs font-normal text-[#212842]/55">{r.flow}</code> : null}
                        {r.tag ? <code className="text-xs font-normal text-[#212842]/55">{r.tag}</code> : null}
                      </p>
                      <p className="mt-0.5 text-xs text-[#212842]/70">{r.reason}</p>
                    </div>
                    {r.status === "open" ? (
                      canApply ? (
                        <ApplyStep actionId={advice!.actionId} index={i} label={t("advice.apply")} />
                      ) : null
                    ) : (
                      <span className={`justify-self-start rounded-full px-2.5 py-1 text-xs font-medium sm:justify-self-end ${r.status === "done" ? "bg-[#e7f1ea] text-[#2f6d44]" : "bg-[#fdf0dc] text-[#a0621e]"}`}>
                        {r.status === "done" ? "✓ " : ""}
                        {t(`advice.${r.status}`)}
                        {r.result ? ` · ${t(`advice.result.${r.result}`)}` : ""}
                      </span>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </>
        )}
      </div>
      <p className="text-xs text-muted-foreground">🔒 {t("privacy")}</p>
    </section>
  );
}
