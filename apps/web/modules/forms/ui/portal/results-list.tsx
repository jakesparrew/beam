/**
 * The customer portal list "My results" (forms spec section 5, R2; forms-P8). A server
 * component without state: the page passes the translated labels, the rows with their texts
 * already in the customer's locale, and the server action behind "View result" (it issues a
 * fresh result token and redirects). Open submissions link to the hosted form, where the
 * customer's session continues the same submission (U5). Never shows an answer value or a score.
 */
import type { ReactNode } from "react";
import { Button, EmptyState } from "@beam/ui";

export type ResultsListLabels = {
  completedHeading: string;
  openHeading: string;
  viewResult: string;
  continue: string;
  noResultPage: string;
  empty: string;
};

export type ResultsListCompleted = {
  submissionId: string;
  title: string;
  /** "Completed on 3 November 2026". */
  when: string;
  /** "Result: Well recovered", or null without an outcome. */
  outcome: string | null;
  hasResultPage: boolean;
  /** Accessible name of the button ("View result of Recovery check"). */
  viewLabel: string;
};

export type ResultsListOpen = {
  submissionId: string;
  title: string;
  /** "Last saved on 3 November 2026". */
  when: string;
  href: string;
  /** Accessible name of the link ("Continue Recovery check"). */
  continueLabel: string;
};

export type ResultsListProps = {
  labels: ResultsListLabels;
  completed: readonly ResultsListCompleted[];
  open: readonly ResultsListOpen[];
  /** Posts `submissionId`; issues a fresh result token and redirects to the result page. */
  viewAction: (formData: FormData) => Promise<void>;
  /** The empty state's next action (a link to the featured assessment), when there is one. */
  emptyAction?: ReactNode;
};

export function ResultsList({ labels, completed, open, viewAction, emptyAction }: ResultsListProps) {
  if (!completed.length && !open.length) return <EmptyState title={labels.empty} action={emptyAction} />;
  return (
    <div className="space-y-8">
      {open.length ? (
        <section aria-labelledby="my-results-open" className="space-y-3">
          <h2 id="my-results-open" className="text-xl font-semibold">
            {labels.openHeading}
          </h2>
          <ul className="grid gap-3">
            {open.map((o) => (
              <li key={o.submissionId} className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border p-4">
                <div className="space-y-1">
                  <p className="font-medium">{o.title}</p>
                  <p className="text-sm text-muted-foreground">{o.when}</p>
                </div>
                <a
                  href={o.href}
                  aria-label={o.continueLabel}
                  className="inline-flex min-h-11 items-center rounded-md border border-border px-4 text-sm font-medium underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                >
                  {labels.continue}
                </a>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {completed.length ? (
        <section aria-labelledby="my-results-completed" className="space-y-3">
          <h2 id="my-results-completed" className="text-xl font-semibold">
            {labels.completedHeading}
          </h2>
          <ul className="grid gap-3">
            {completed.map((c) => (
              <li key={c.submissionId} className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border p-4">
                <div className="space-y-1">
                  <p className="font-medium">{c.title}</p>
                  <p className="text-sm text-muted-foreground">{c.when}</p>
                  {c.outcome ? <p className="text-sm">{c.outcome}</p> : null}
                </div>
                {c.hasResultPage ? (
                  <form action={viewAction}>
                    <input type="hidden" name="submissionId" value={c.submissionId} />
                    <Button type="submit" className="min-h-11" aria-label={c.viewLabel}>
                      {labels.viewResult}
                    </Button>
                  </form>
                ) : (
                  <p className="text-sm text-muted-foreground">{labels.noResultPage}</p>
                )}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
