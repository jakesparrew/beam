/**
 * The Review step's checklist (email spec rule 26, section 5 "Review lists every blocking check
 * with a link to fix it"): segment, content, completeness for every audience locale, a test send
 * after the last edit, and the legal footer data. Presentational; the page passes the checklist
 * computed by `getCampaign`.
 */
import Link from "next/link";
import { Badge } from "@beam/ui";
import type { Locale } from "@beam/core/i18n";
import { clab, type CampaignLabels } from "./CampaignStepper";

export type ReviewChecklistData = {
  checks: readonly { key: "segment" | "content" | "locales" | "test_send" | "footer"; ok: boolean; detail?: string }[];
  audienceLocales: readonly Locale[];
  missing: readonly { locale: Locale; missing: readonly string[] }[];
};

function fixHref(campaignId: string, key: ReviewChecklistData["checks"][number]["key"]) {
  switch (key) {
    case "segment":
      return `/admin/campaigns/${campaignId}?step=audience` as const;
    case "content":
    case "locales":
      return `/admin/campaigns/${campaignId}?step=content` as const;
    case "test_send":
      return `/admin/campaigns/${campaignId}?step=review#test-send` as const;
    case "footer":
      return "/admin/settings" as const;
  }
}

export function ReviewChecklist(props: { campaignId: string; review: ReviewChecklistData; localeNames: Record<Locale, string>; labels: CampaignLabels }) {
  const { labels, review } = props;
  return (
    <section className="grid gap-3" data-testid="review-checklist">
      <h2 className="text-lg font-semibold">{clab(labels, "review_title")}</h2>
      {review.audienceLocales.length ? (
        <p className="text-sm text-muted-foreground">{clab(labels, "audience_locales", { locales: review.audienceLocales.map((l) => props.localeNames[l]).join(", ") })}</p>
      ) : null}
      <ul className="grid gap-2">
        {review.checks.map((c) => (
          <li key={c.key} className="flex flex-wrap items-center gap-3 rounded-md border p-3 text-sm" data-check={c.key} data-ok={c.ok ? "true" : "false"}>
            <Badge variant={c.ok ? "default" : "destructive"}>{clab(labels, c.ok ? "check_ok" : "check_missing")}</Badge>
            <span className="font-medium">{clab(labels, `check_${c.key}`)}</span>
            {!c.ok ? (
              <Link className="underline underline-offset-2" href={fixHref(props.campaignId, c.key)}>
                {clab(labels, "fix")}
              </Link>
            ) : null}
            {c.key === "locales" && !c.ok
              ? review.missing.map((m) => (
                  <span key={m.locale} className="w-full text-muted-foreground">
                    {clab(labels, "missing_in", { locale: props.localeNames[m.locale], items: m.missing.slice(0, 8).join(", ") + (m.missing.length > 8 ? ", ..." : "") })}
                  </span>
                ))
              : null}
            {c.key === "footer" && !c.ok && c.detail ? <span className="w-full text-muted-foreground">{c.detail}</span> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
