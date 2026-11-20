/**
 * The pieces of the public booking flow (`/[locale]/book`): the step bar, the explainer cards that
 * keep telling the visitor about BEAM on every step, and the trust strip. Login comes last, so a
 * visitor first sees what they get, when, and for how much.
 */
import type { ReactNode } from "react";
import type { Tr } from "./block-renderer";

export const BOOK_STEPS = ["experience", "moment", "details", "pay"] as const;

export function BookSteps({ current, tr }: { current: 1 | 2 | 3 | 4; tr: Tr }) {
  return (
    <nav aria-label={tr("site.bookFlow.stepOf", { n: current })} className="mb-8">
      <p className="mb-3 text-xs font-semibold tracking-[0.25em] text-[#a0621e] uppercase sm:hidden">{tr("site.bookFlow.stepOf", { n: current })}</p>
      <ol className="flex items-center gap-2 sm:gap-3">
        {BOOK_STEPS.map((step, i) => {
          const n = i + 1;
          const done = n < current;
          const now = n === current;
          return (
            <li key={step} className="flex flex-1 items-center gap-2 sm:gap-3" aria-current={now ? "step" : undefined}>
              <span
                className={`grid size-8 shrink-0 place-items-center rounded-full text-sm font-semibold ${now ? "bg-[#212842] text-[#fffaef]" : done ? "bg-[#d1a64a] text-[#212842]" : "border border-border bg-card text-muted-foreground"}`}
              >
                {done ? "✓" : n}
              </span>
              <span className={`hidden text-sm sm:inline ${now ? "font-semibold" : "text-muted-foreground"}`}>{tr(`site.bookFlow.steps.${step}`)}</span>
              {n < BOOK_STEPS.length ? <span aria-hidden="true" className={`h-px flex-1 ${done ? "bg-[#d1a64a]" : "bg-border"}`} /> : null}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/** A soft explainer card for the side column. */
export function InfoCard({ title, children, tone = "light" }: { title: string; children: ReactNode; tone?: "light" | "sand" }) {
  return (
    <section className={`rounded-3xl p-6 ${tone === "sand" ? "bg-[#f4ead3]" : "border border-border bg-card"}`}>
      <h2 className="font-display mb-2 text-xl">{title}</h2>
      <div className="space-y-2 text-sm leading-relaxed text-muted-foreground">{children}</div>
    </section>
  );
}

export function TrustStrip({ tr }: { tr: Tr }) {
  const items = [tr("site.bookFlow.trust.payLast"), tr("site.bookFlow.trust.methods"), tr("site.bookFlow.trust.reviews")];
  return (
    <ul className="flex flex-wrap gap-x-6 gap-y-2 text-sm text-muted-foreground">
      {items.map((t) => (
        <li key={t} className="flex items-center gap-2">
          <span aria-hidden="true" className="grid size-5 place-items-center rounded-full bg-[#d1a64a]/20 text-xs text-[#a0621e]">
            ✓
          </span>
          {t}
        </li>
      ))}
    </ul>
  );
}

/** Reassurance lines with a gold check (cancellation, secure payment, confirmation, help). */
export function TrustList({ items }: { items: string[] }) {
  return (
    <ul className="grid gap-3 text-sm">
      {items.map((t) => (
        <li key={t} className="flex gap-3">
          <span aria-hidden="true" className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-[#3f8f5a]/15 text-[0.7rem] font-bold text-[#2f6d44]">
            ✓
          </span>
          <span className="text-[#212842]/80">{t}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * The order summary beside the last two steps: BEAM's space as a photo, the session, the lines and
 * the total, then the reassurance list. Sticky on wide screens so the total stays in view.
 */
export function SummaryAside({
  kind,
  heading,
  title,
  when,
  lines,
  total,
  trust,
}: {
  kind: "day" | "night";
  heading: string;
  title: string;
  when: string[];
  lines: { label: string; amount: string }[];
  total: { label: string; amount: string } | null;
  trust: string[];
}) {
  return (
    <aside className="lg:sticky lg:top-24 lg:self-start">
      <div className="overflow-hidden rounded-[2rem] bg-card shadow-[0_1px_2px_rgb(33_40_66/0.04),0_24px_48px_-28px_rgb(33_40_66/0.35)]">
        <div className="relative isolate h-36">
          {/* eslint-disable-next-line @next/next/no-img-element -- static brand photo */}
          <img src={`/brand/book-${kind}.webp`} alt="" className="absolute inset-0 -z-20 h-full w-full object-cover" />
          <div aria-hidden="true" className="absolute inset-0 -z-10 bg-[linear-gradient(180deg,rgba(23,28,48,0.1),rgba(23,28,48,0.8))]" />
          <p className="absolute bottom-4 left-6 text-xs font-semibold tracking-[0.25em] text-[#ffd76a] uppercase">{heading}</p>
        </div>
        <div className="grid gap-5 p-6">
          <div>
            <p className="font-display text-2xl">{title}</p>
            {when.map((w) => (
              <p key={w} className="text-sm text-muted-foreground first-letter:uppercase">
                {w}
              </p>
            ))}
          </div>
          {lines.length || total ? (
            <dl className="grid gap-2 border-t border-dashed border-border pt-4 text-sm">
              {lines.map((l) => (
                <div key={l.label} className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">{l.label}</dt>
                  <dd className="tabular-nums">{l.amount}</dd>
                </div>
              ))}
              {total ? (
                <div className="mt-1 flex items-baseline justify-between gap-4 border-t border-border pt-3">
                  <dt className="font-semibold">{total.label}</dt>
                  <dd className="text-2xl font-semibold tabular-nums">{total.amount}</dd>
                </div>
              ) : null}
            </dl>
          ) : null}
          <div className="rounded-2xl bg-[#f6efdf] p-4">
            <TrustList items={trust} />
          </div>
        </div>
      </div>
    </aside>
  );
}

/** "Good to know" and "What to bring" for the chosen kind. */
export function KindTips({ kind, tr }: { kind: "day" | "night"; tr: Tr }) {
  const tips = [1, 2, 3].map((n) => tr(`site.bookFlow.tips.${kind}${n}`));
  return (
    <div className="grid gap-4">
      <InfoCard title={tr("site.bookFlow.tips.title")} tone="sand">
        <ul className="space-y-2">
          {tips.map((t) => (
            <li key={t} className="flex gap-2">
              <span aria-hidden="true" className="text-[#a0621e]">
                ✦
              </span>
              <span className="text-[#212842]/80">{t}</span>
            </li>
          ))}
        </ul>
      </InfoCard>
      <InfoCard title={tr("site.bookFlow.bring.title")}>
        <p>{tr("site.bookFlow.bring.body")}</p>
      </InfoCard>
    </div>
  );
}
