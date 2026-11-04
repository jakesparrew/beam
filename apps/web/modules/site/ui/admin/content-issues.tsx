/**
 * Content issues panel of `/admin/site` (site spec section 5): the red go-live banner (missing
 * legal pages, company identification) and the other issues (blocking drafts, failed schedules,
 * hidden menu targets, inactive products, past or missing event sessions, opening hours), each
 * linking to its page. Also the open Claude requests. A server component.
 */
import NextLink from "next/link";
import type { Route } from "next";
import { Alert, AlertDescription, AlertTitle } from "@beam/ui";
import type { ContentIssue, OpenEditRequest, SiteAdminLabels } from "../../queries/admin";

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
    </div>
  );
}
