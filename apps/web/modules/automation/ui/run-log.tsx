/**
 * The run log and enrolment tables (automation spec 5, `/admin/automations/[id]/runs` and
 * `/enrolments`, and the overview's latest runs): time, person (link to the person page), step,
 * outcome badge, reason, email status and task; filters are plain GET forms (outcome and date
 * range; enrolment status) and paging is a "Show more" link with the keyset cursor. Times are
 * Europe/Brussels. Server-rendered; every string arrives through `l`.
 */
import Link from "next/link";
import { Button, EmptyState, Input, Label, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@beam/ui";
import { formatDateTime, type Locale } from "@beam/core/i18n";
import type { AutomationRunOutcome } from "@beam/core/automation";
import { AUTOMATION_RUN_OUTCOMES } from "@beam/db/schema";
import { fill, OutcomeBadge, type Labels } from "./outcome-badge";

const selectClass = "h-9 rounded-md border border-input bg-background px-3 text-sm";

export type RunLogRow = {
  id: string;
  personId: string;
  firstName: string | null;
  lastName: string | null;
  occurredAt: Date;
  automationName: string;
  stepKey: string | null;
  outcome: AutomationRunOutcome;
  reason: string | null;
  endReason: string | null;
  emailMessageId: string | null;
  emailStatus: string | null;
  taskId: string | null;
};

const personName = (r: { firstName: string | null; lastName: string | null }, l: Labels) => [r.firstName, r.lastName].filter(Boolean).join(" ") || l["enrolments.unnamed"];

/** The end reason in words: `exit_event:order.paid` -> "Exit event (order.paid)". */
export function endReasonText(reason: string | null, l: Labels): string {
  if (!reason) return "";
  const [head, ...rest] = reason.split(":");
  const label = l[`end_reason.${head}`] ?? reason;
  return rest.length ? `${label} (${rest.join(":")})` : label;
}

export function RunFilters({ action, l, value }: { action: string; l: Labels; value: { outcome?: string; from?: string; to?: string } }) {
  return (
    <form method="get" action={action} className="flex flex-wrap items-end gap-3" data-testid="run-filters">
      <div className="grid gap-1">
        <Label htmlFor="run-filter-outcome">{l["runs.filter_outcome"]}</Label>
        <select id="run-filter-outcome" name="outcome" defaultValue={value.outcome ?? ""} className={selectClass}>
          <option value="">{l["common.all"]}</option>
          {AUTOMATION_RUN_OUTCOMES.map((o) => (
            <option key={o} value={o}>
              {l[`outcome.${o}`]}
            </option>
          ))}
        </select>
      </div>
      <div className="grid gap-1">
        <Label htmlFor="run-filter-from">{l["runs.from"]}</Label>
        <Input id="run-filter-from" type="date" name="from" defaultValue={value.from ?? ""} />
      </div>
      <div className="grid gap-1">
        <Label htmlFor="run-filter-to">{l["runs.to"]}</Label>
        <Input id="run-filter-to" type="date" name="to" defaultValue={value.to ?? ""} />
      </div>
      <Button type="submit" variant="outline">
        {l["common.apply"]}
      </Button>
    </form>
  );
}

export function RunLog({ rows, l, locale, moreHref, showAutomation = false }: { rows: RunLogRow[]; l: Labels; locale: Locale; moreHref?: string | null; showAutomation?: boolean }) {
  if (rows.length === 0) return <EmptyState title={l["runs.empty"]} />;
  return (
    <div className="grid gap-3">
      <p className="text-xs text-muted-foreground">{l["common.times_in_zone"]}</p>
      <Table data-testid="run-log">
        <TableHeader>
          <TableRow>
            <TableHead>{l["runs.col_time"]}</TableHead>
            <TableHead>{l["runs.col_person"]}</TableHead>
            {showAutomation ? <TableHead>{l["runs.col_automation"]}</TableHead> : null}
            <TableHead>{l["runs.col_step"]}</TableHead>
            <TableHead>{l["runs.col_outcome"]}</TableHead>
            <TableHead>{l["runs.col_reason"]}</TableHead>
            <TableHead>{l["runs.col_email"]}</TableHead>
            <TableHead>{l["runs.col_task"]}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.id} data-outcome={r.outcome}>
              <TableCell>
                <time dateTime={r.occurredAt.toISOString()}>{formatDateTime(r.occurredAt, locale)}</time>
              </TableCell>
              <TableCell>
                <Link className="underline-offset-2 hover:underline" href={`/admin/persons/${r.personId}`}>
                  {personName(r, l)}
                </Link>
              </TableCell>
              {showAutomation ? <TableCell>{r.automationName}</TableCell> : null}
              <TableCell className="font-mono text-xs">{r.stepKey ?? ""}</TableCell>
              <TableCell>
                <OutcomeBadge outcome={r.outcome} label={l[`outcome.${r.outcome}`] ?? r.outcome} />
              </TableCell>
              <TableCell className="max-w-xs text-xs">{r.outcome === "exited" || r.outcome === "completed" ? endReasonText(r.endReason, l) || (r.reason ?? "") : (r.reason ?? "")}</TableCell>
              <TableCell className="text-xs">{r.emailStatus ?? ""}</TableCell>
              <TableCell>
                {r.taskId ? (
                  <Link className="text-xs underline-offset-2 hover:underline" href="/admin/tasks">
                    {l["runs.open_task"]}
                  </Link>
                ) : null}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {moreHref ? (
        <Link href={moreHref as never} className="w-fit text-sm underline-offset-2 hover:underline" data-testid="runs-more">
          {l["common.more"]}
        </Link>
      ) : null}
    </div>
  );
}

export type EnrolmentView = {
  id: string;
  personId: string;
  firstName: string | null;
  lastName: string | null;
  status: "active" | "completed" | "exited";
  source: string;
  enteredAt: Date;
  nextStepKey: string | null;
  nextStepAt: Date | null;
  endReason: string | null;
  versionNumber: number;
};

export function EnrolmentFilters({ action, l, status }: { action: string; l: Labels; status?: string }) {
  return (
    <form method="get" action={action} className="flex flex-wrap items-end gap-3">
      <div className="grid gap-1">
        <Label htmlFor="enrolment-filter-status">{l["enrolments.filter_status"]}</Label>
        <select id="enrolment-filter-status" name="status" defaultValue={status ?? ""} className={selectClass}>
          <option value="">{l["common.all"]}</option>
          {(["active", "completed", "exited"] as const).map((s) => (
            <option key={s} value={s}>
              {l[`enrolment_status.${s}`]}
            </option>
          ))}
        </select>
      </div>
      <Button type="submit" variant="outline">
        {l["common.apply"]}
      </Button>
    </form>
  );
}

export function EnrolmentTable({ rows, l, locale, moreHref }: { rows: EnrolmentView[]; l: Labels; locale: Locale; moreHref?: string | null }) {
  if (rows.length === 0) return <EmptyState title={l["enrolments.empty"]} />;
  return (
    <div className="grid gap-3">
      <p className="text-xs text-muted-foreground">{l["common.times_in_zone"]}</p>
      <Table data-testid="enrolment-table">
        <TableHeader>
          <TableRow>
            <TableHead>{l["enrolments.col_person"]}</TableHead>
            <TableHead>{l["enrolments.col_status"]}</TableHead>
            <TableHead>{l["enrolments.col_source"]}</TableHead>
            <TableHead>{l["enrolments.col_version"]}</TableHead>
            <TableHead>{l["enrolments.col_entered"]}</TableHead>
            <TableHead>{l["enrolments.col_next"]}</TableHead>
            <TableHead>{l["enrolments.col_end_reason"]}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.id} data-status={r.status}>
              <TableCell>
                <Link className="underline-offset-2 hover:underline" href={`/admin/persons/${r.personId}`}>
                  {personName(r, l)}
                </Link>
              </TableCell>
              <TableCell>{l[`enrolment_status.${r.status}`]}</TableCell>
              <TableCell>{l[`source.${r.source}`] ?? r.source}</TableCell>
              <TableCell className="tabular-nums">{`v${r.versionNumber}`}</TableCell>
              <TableCell>{formatDateTime(r.enteredAt, locale)}</TableCell>
              <TableCell>{r.nextStepKey && r.nextStepAt ? fill(l["enrolments.next_at"], { step: r.nextStepKey, date: formatDateTime(r.nextStepAt, locale) }) : ""}</TableCell>
              <TableCell>{endReasonText(r.endReason, l)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {moreHref ? (
        <Link href={moreHref as never} className="w-fit text-sm underline-offset-2 hover:underline">
          {l["common.more"]}
        </Link>
      ) : null}
    </div>
  );
}
