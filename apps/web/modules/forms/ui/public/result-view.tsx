"use client";

/**
 * The personalised result page body (forms spec section 5 `/[locale]/f/[slug]/r/[token]`, rules
 * ID7 and SE3): ending title and text, the score when the ending shows it, the dimensions with
 * their range label and explanation (a null dimension is hidden, edge case 5), the outcome label,
 * explanation and recommendation, and the CTAs through the `go` redirect (which adds a fresh
 * identity token). Every value arrives resolved to the submission locale; the page never shows
 * an email, phone or raw answer (edge case 18). On mount it sends the `viewed` beacon once.
 */
import { useEffect, useRef } from "react";
import type { Locale } from "@beam/core/i18n";
import { Markdown, type PublicLabels } from "./field-inputs";

export type ResultDimensionView = { key: string; label: string; value: number; rangeLabel: string | null; explanation: string | null };

export type ResultViewProps = {
  token: string;
  locale: Locale;
  formTitle: string;
  endingTitle: string;
  endingBody: string;
  total: number | null;
  totalRangeLabel: string | null;
  dimensions: ResultDimensionView[];
  outcome: { label: string; explanation: string | null; recommendation: string | null } | null;
  ctas: { key: string; label: string; url: string }[];
  labels: PublicLabels;
};

export function ResultView(p: ResultViewProps) {
  const sent = useRef(false);
  useEffect(() => {
    if (sent.current) return;
    sent.current = true;
    void fetch(`/api/public/forms/result/${encodeURIComponent(p.token)}/viewed`, { method: "POST", credentials: "include" }).catch(() => undefined);
  }, [p.token]);
  const nf = new Intl.NumberFormat(p.locale, { maximumFractionDigits: 2 });
  return (
    <article lang={p.locale} className="mx-auto w-full max-w-2xl space-y-8">
      <header className="space-y-2">
        <p className="text-sm text-muted-foreground">{p.formTitle}</p>
        <h1 className="text-3xl font-semibold">{p.endingTitle}</h1>
      </header>
      {p.endingBody ? <Markdown text={p.endingBody} /> : null}
      {p.total !== null ? (
        <section aria-labelledby="result-score" className="space-y-1 rounded-md border border-border p-4">
          <h2 id="result-score" className="text-lg font-semibold">
            {p.labels.your_score}
          </h2>
          <p className="text-3xl font-semibold" data-result-score>
            {nf.format(p.total)}
          </p>
          {p.totalRangeLabel ? <p>{p.totalRangeLabel}</p> : null}
        </section>
      ) : null}
      {p.dimensions.length ? (
        <ul className="space-y-3">
          {p.dimensions.map((d) => (
            <li key={d.key} className="rounded-md border border-border p-4">
              <p className="font-medium">
                {d.label}: {nf.format(d.value)}
                {d.rangeLabel ? ` · ${d.rangeLabel}` : ""}
              </p>
              {d.explanation ? <Markdown text={d.explanation} className="mt-1 space-y-1 text-sm" /> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {p.outcome ? (
        <section aria-labelledby="result-outcome" className="space-y-2">
          <h2 id="result-outcome" className="text-lg font-semibold">
            {p.labels.your_profile}
          </h2>
          <p className="text-xl font-medium" data-result-outcome>
            {p.outcome.label}
          </p>
          {p.outcome.explanation ? <Markdown text={p.outcome.explanation} /> : null}
          {p.outcome.recommendation ? (
            <div className="space-y-1">
              <h3 className="font-semibold">{p.labels.recommended_for_you}</h3>
              <Markdown text={p.outcome.recommendation} />
            </div>
          ) : null}
        </section>
      ) : null}
      {p.ctas.length ? (
        <nav aria-label={p.labels.next_steps} className="flex flex-wrap gap-3">
          {p.ctas.map((c) => (
            <a key={c.key} href={c.url} className="inline-flex min-h-11 items-center rounded-md bg-primary px-5 font-medium text-primary-foreground" data-cta={c.key}>
              {c.label}
            </a>
          ))}
        </nav>
      ) : null}
    </article>
  );
}
