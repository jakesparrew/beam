/**
 * Content issues panel of `/admin/site` (site spec section 5): the red go-live banner (missing
 * legal pages, company identification) and the other issues (blocking drafts, failed schedules,
 * hidden menu targets, inactive products, past or missing event sessions, opening hours), each
 * linking to its page. Also the open Claude requests. A server component.
 *
 * R4 (site-P10): below the issues, the latest weekly Claude audit (`site_audit_reports`, written
 * by `site.audit_content` on Monday 07:10): its week and findings per page, warnings first, each
 * linking to the page. Claude's suggestion text (English) is shown next to the finding's label.
 */
import NextLink from "next/link";
import type { Route } from "next";
import { Alert, AlertDescription, AlertTitle, Badge } from "@beam/ui";
import type { Locale } from "@beam/core/i18n";
import { adminLocale } from "@/lib/i18n";
import { AUDIT_AI_CODES, getLatestAuditReport, type AuditReportView } from "../../jobs/audit";
import type { ContentIssue, OpenEditRequest, SiteAdminLabels } from "../../queries/admin";

/** A label with `{name}` placeholders filled (server-side twin of the editor's `lbl`). */
function lbl(L: SiteAdminLabels, key: string, params?: Record<string, string | number>): string {
  const template = L[key] ?? key;
  return params ? template.replace(/\{(\w+)\}/g, (m, name: string) => (name in params ? String(params[name]) : m)) : template;
}

/** The audit week (a Monday, `YYYY-MM-DD`) as a long date in the staff locale. */
function weekLabel(weekOn: string, locale: Locale): string {
  const at = new Date(`${weekOn}T12:00:00Z`);
  return Number.isNaN(at.getTime()) ? weekOn : new Intl.DateTimeFormat(locale, { dateStyle: "long", timeZone: "UTC" }).format(at);
}

/** At most this many audit findings are listed; the rest are counted. */
export const AUDIT_FINDINGS_SHOWN = 50;

export function AuditReportPanel({ report, L, locale = "en" }: { report: AuditReportView | null; L: SiteAdminLabels; locale?: Locale }) {
  const findings = report ? [...report.findings].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "warn" ? -1 : 1)) : [];
  const shown = findings.slice(0, AUDIT_FINDINGS_SHOWN);
  return (
    <section className="grid gap-2" aria-labelledby="site-audit-title" data-testid="site-audit-report">
      <h2 id="site-audit-title" className="text-lg font-semibold">
        {lbl(L, "audit.title")}
      </h2>
      {!report ? (
        <p className="text-sm text-muted-foreground">{lbl(L, "audit.empty")}</p>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">{lbl(L, "audit.week", { date: weekLabel(report.weekOn, locale) })}</p>
          {shown.length ? (
            <ul className="grid gap-1 text-sm">
              {shown.map((f, k) => (
                <li key={k} className="flex flex-wrap items-baseline gap-2" data-severity={f.severity}>
                  <Badge variant={f.severity === "warn" ? "warning" : "secondary"}>{lbl(L, `audit.severity.${f.severity}`)}</Badge>
                  <NextLink className="font-medium underline" href={`/admin/site/pages/${f.pageId}` as Route}>
                    {f.title}
                  </NextLink>
                  <span>
                    {L[`audit.code.${f.code}`] ?? L[`issue.${f.code}`] ?? f.code} ({f.locale})
                  </span>
                  {(AUDIT_AI_CODES as readonly string[]).includes(f.code) ? <span className="text-muted-foreground">{f.message}</span> : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">{lbl(L, "audit.none")}</p>
          )}
          {findings.length > shown.length ? <p className="text-xs text-muted-foreground">{lbl(L, "audit.more", { count: findings.length - shown.length })}</p> : null}
        </>
      )}
    </section>
  );
}

/** Loads the latest audit report in the staff locale and renders it (an async server component). */
export async function AuditReport({ L, locale }: { L: SiteAdminLabels; locale?: Locale }) {
  const reportLocale = locale ?? (await adminLocale());
  let report: AuditReportView | null = null;
  try {
    report = await getLatestAuditReport(reportLocale);
  } catch {
    // The issues panel still renders when the report cannot be read.
  }
  return <AuditReportPanel report={report} L={L} locale={reportLocale} />;
}

function IssueLine({ issue, L }: { issue: ContentIssue; L: SiteAdminLabels }) {
  const text = (issue.code === "draft_issues" ? L["editor.issues"] : L[`issue.${issue.code}`]) ?? issue.code;
  const detail =
    issue.code === "legal_page_missing"
      ? L[`legalKey.${issue.details?.[0]}`]
      : issue.code === "company_identification_missing"
        ? issue.details?.join(", ")
        : issue.code === "draft_issues"
          ? issue.details?.map((c) => L[`issue.${c}`] ?? c).join(" ")
          : issue.locale;
  return (
    <li>
      {issue.pageId ? (
        <NextLink className="font-medium underline" href={`/admin/site/pages/${issue.pageId}` as Route}>
          {issue.title ?? issue.pageId}
        </NextLink>
      ) : null}
      {issue.pageId ? ": " : ""}
      {text}
      {detail ? <span className="text-muted-foreground"> ({detail})</span> : null}
    </li>
  );
}

export function ContentIssues({ issues, requests, L }: { issues: ContentIssue[]; requests: OpenEditRequest[]; L: SiteAdminLabels }) {
  const goLive = issues.filter((i) => i.goLive);
  const rest = issues.filter((i) => !i.goLive);
  return (
    <div className="grid gap-4">
      {goLive.length ? (
        <Alert variant="destructive" data-testid="site-go-live-banner">
          <AlertTitle>{L["issue.goLive"]}</AlertTitle>
          <AlertDescription>
            <ul className="grid list-disc gap-1 pl-4">
              {goLive.map((i, k) => (
                <IssueLine key={k} issue={i} L={L} />
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}
      <section className="grid gap-2" aria-labelledby="site-issues-title">
        <h2 id="site-issues-title" className="text-lg font-semibold">
          {L["issue.title"]}
        </h2>
        {rest.length ? (
          <ul className="grid list-disc gap-1 pl-4 text-sm">
            {rest.map((i, k) => (
              <IssueLine key={k} issue={i} L={L} />
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">{L["issue.none"]}</p>
        )}
      </section>
      {requests.length ? (
        <section className="grid gap-2" aria-labelledby="site-requests-title">
          <h2 id="site-requests-title" className="text-lg font-semibold">
            {L["pages.openRequests"]}
          </h2>
          <ul className="grid list-disc gap-1 pl-4 text-sm">
            {requests.map((r) => (
              <li key={r.editRequestId}>
                <NextLink className="underline" href={`/admin/site/pages/${r.pageId}` as Route}>
                  {r.title}
                </NextLink>{" "}
                ({L["claude.running"]})
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <AuditReport L={L} />
    </div>
  );
}
