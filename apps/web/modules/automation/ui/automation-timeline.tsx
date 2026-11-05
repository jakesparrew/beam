"use client";
/**
 * The automation timeline of the person page (automation spec 5, A-41): every run row, newest
 * first, with time (Europe/Brussels, formatted on the server), automation name, step, outcome
 * badge, reason or end reason, and email status. Outcome filters: all, or one outcome family
 * (done, journey, skipped, failed), with the blueprint list mapped as A-41 says (`entered` with
 * the trigger, step outcomes, `skipped_*`, `branched`, `exited` with its end reason).
 */
import { useState } from "react";
import { Button } from "@beam/ui";
import type { AutomationRunOutcome } from "@beam/core/automation";
import { OutcomeBadge, outcomeFamily, type Labels, type OutcomeFamily } from "./outcome-badge";

export type TimelineRow = {
  id: string;
  time: string;
  iso: string;
  automationName: string;
  stepKey: string | null;
  outcome: AutomationRunOutcome;
  /** The run reason, or the end reason in words for `exited` and `completed`. */
  detail: string | null;
  emailStatus: string | null;
};

const FAMILIES: readonly OutcomeFamily[] = ["done", "info", "skipped", "failed"];

export function AutomationTimeline(p: { rows: TimelineRow[]; labels: Labels }) {
  const l = p.labels;
  const [filter, setFilter] = useState<OutcomeFamily | "all">("all");
  const rows = filter === "all" ? p.rows : p.rows.filter((r) => outcomeFamily(r.outcome) === filter);
  return (
    <div className="grid gap-3" data-testid="automation-timeline">
      <div className="flex flex-wrap gap-2" role="group" aria-label={l["panel.filter_label"]}>
        {(["all", ...FAMILIES] as const).map((f) => (
          <Button
            key={f}
            type="button"
            size="sm"
            variant={filter === f ? "default" : "outline"}
            aria-pressed={filter === f}
            onClick={() => setFilter(f)}
            data-testid={`automation-timeline-filter-${f}`}
          >
            {l[`panel.filter.${f}`] ?? f}
          </Button>
        ))}
      </div>
      {rows.length ? (
        <ol className="grid gap-2 text-sm">
          {rows.map((r) => (
            <li key={r.id} className="flex flex-wrap items-baseline gap-x-2 border-b pb-2" data-run-outcome={r.outcome} data-step={r.stepKey ?? ""}>
              <time dateTime={r.iso} className="text-muted-foreground">
                {r.time}
              </time>
              <strong>{r.automationName}</strong>
              {r.stepKey ? <span className="font-mono">{r.stepKey}</span> : null}
              <OutcomeBadge outcome={r.outcome} label={l[`outcome.${r.outcome}`] ?? r.outcome} />
              {r.detail ? <small className="text-muted-foreground">{r.detail}</small> : null}
              {r.emailStatus ? (
                <small>
                  {l["panel.email_status"]}: {r.emailStatus}
                </small>
              ) : null}
            </li>
          ))}
        </ol>
      ) : (
        <p className="text-sm text-muted-foreground">{l["panel.timeline_empty"]}</p>
      )}
    </div>
  );
}
