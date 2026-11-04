"use client";
/**
 * The support register table (`/admin/system/support`, from `v_support_sla`) and the reporter's
 * own list (`/admin/support`). A breached due time is shown in red with a text marker, not by
 * colour alone (PL-90). The register rows open an update form: status (section 2 transitions,
 * `responded` needs a note), note, assignee and linked incident (PL-87).
 */
import { Fragment, useState, type FormEvent } from "react";
import { Badge, Button, FormField, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, Textarea } from "@beam/ui";
import { updateSupportRequest } from "../actions";
import { formValue } from "./login-form";
import { Feedback, lab, useRun, type Labels } from "./settings-form";

export type SupportTableRow = {
  id: string;
  reference: string;
  severity: string;
  channel: string;
  title: string;
  status: string;
  receivedAt: string;
  responseDueAt: string;
  firstResponseAt: string | null;
  isBreached: boolean;
  reporter: string | null;
  assignee: string | null;
};

const NEXT: Record<string, string[]> = { open: ["responded", "resolved"], responded: ["resolved"], resolved: ["closed", "open"], closed: [] };

function when(iso: string | null, locale: string): string {
  return iso ? new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short", timeZone: "Europe/Brussels" }).format(new Date(iso)) : "–";
}

function UpdateForm({ row, labels, errors, staff, incidents }: { row: SupportTableRow; labels: Labels; errors: Labels; staff: { id: string; name: string }[]; incidents: { id: string; title: string }[] }) {
  const r = useRun(errors);
  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const status = formValue(form, "status");
    const note = formValue(form, "note").trim();
    const assignee = formValue(form, "assigneeUserId");
    const incident = formValue(form, "incidentId");
    await r.run(
      () =>
        updateSupportRequest({
          id: row.id,
          ...(status ? { status } : {}),
          ...(note ? { note } : {}),
          assigneeUserId: assignee || null,
          incidentId: incident || null,
        }),
      lab(labels, "updated"),
    );
  }
  return (
    <form onSubmit={(e) => void onSubmit(e)} className="grid gap-3 p-3" noValidate>
      <div className="grid gap-3 sm:grid-cols-3">
        <FormField label={lab(labels, "col_status")}>
          <select name="status" className="h-9 rounded-md border bg-background px-2 text-sm" defaultValue="">
            <option value="">{lab(labels, "keep_status")}</option>
            {(NEXT[row.status] ?? []).map((s) => (
              <option key={s} value={s}>
                {lab(labels, `status_${s}`)}
              </option>
            ))}
          </select>
        </FormField>
        <FormField label={lab(labels, "col_assignee")}>
          <select name="assigneeUserId" className="h-9 rounded-md border bg-background px-2 text-sm" defaultValue={staff.find((s) => s.name === row.assignee)?.id ?? ""}>
            <option value="">{lab(labels, "nobody")}</option>
            {staff.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </FormField>
        <FormField label={lab(labels, "incident")}>
          <select name="incidentId" className="h-9 rounded-md border bg-background px-2 text-sm" defaultValue="">
            <option value="">{lab(labels, "no_incident")}</option>
            {incidents.map((i) => (
              <option key={i.id} value={i.id}>
                {i.title}
              </option>
            ))}
          </select>
        </FormField>
      </div>
      <FormField label={lab(labels, "note")} hint={lab(labels, "note_hint")}>
        <Textarea name="note" rows={2} />
      </FormField>
      <Feedback ok={r.ok} error={r.error} />
      <div>
        <Button type="submit" size="sm" disabled={r.pending}>
          {lab(labels, "update")}
        </Button>
      </div>
    </form>
  );
}

export function SupportTable({
  rows,
  labels,
  errors,
  locale,
  manage,
  staff = [],
  incidents = [],
}: {
  rows: SupportTableRow[];
  labels: Labels;
  errors: Labels;
  locale: string;
  manage: boolean;
  staff?: { id: string; name: string }[];
  incidents?: { id: string; title: string }[];
}) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{lab(labels, "col_reference")}</TableHead>
          <TableHead>{lab(labels, "col_severity")}</TableHead>
          {manage ? <TableHead>{lab(labels, "col_channel")}</TableHead> : null}
          <TableHead>{lab(labels, "col_title")}</TableHead>
          <TableHead>{lab(labels, "col_status")}</TableHead>
          <TableHead>{lab(labels, "col_received")}</TableHead>
          <TableHead>{lab(labels, "col_due")}</TableHead>
          <TableHead>{lab(labels, "col_responded")}</TableHead>
          {manage ? <TableHead>{lab(labels, "col_reporter")}</TableHead> : null}
          {manage ? <TableHead>{lab(labels, "col_assignee")}</TableHead> : null}
          {manage ? <TableHead>{lab(labels, "col_actions")}</TableHead> : null}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <Fragment key={row.id}>
            <TableRow data-reference={row.reference}>
              <TableCell className="font-mono text-xs">{row.reference}</TableCell>
              <TableCell>
                <Badge variant={row.severity === "critical" ? "destructive" : row.severity === "high" ? "warning" : "secondary"}>{lab(labels, `severity_${row.severity}`)}</Badge>
              </TableCell>
              {manage ? <TableCell>{lab(labels, `channel_${row.channel}`)}</TableCell> : null}
              <TableCell>{row.title}</TableCell>
              <TableCell>{lab(labels, `status_${row.status}`)}</TableCell>
              <TableCell>{when(row.receivedAt, locale)}</TableCell>
              <TableCell className={row.isBreached ? "font-medium text-destructive" : undefined}>
                {when(row.responseDueAt, locale)}
                {row.isBreached ? ` (${lab(labels, "breached")})` : ""}
              </TableCell>
              <TableCell>{when(row.firstResponseAt, locale)}</TableCell>
              {manage ? <TableCell>{row.reporter ?? "–"}</TableCell> : null}
              {manage ? <TableCell>{row.assignee ?? "–"}</TableCell> : null}
              {manage ? (
                <TableCell>
                  <Button type="button" variant="outline" size="sm" aria-expanded={open === row.id} onClick={() => setOpen(open === row.id ? null : row.id)}>
                    {lab(labels, "edit")}
                  </Button>
                </TableCell>
              ) : null}
            </TableRow>
            {manage && open === row.id ? (
              <TableRow>
                <TableCell colSpan={11}>
                  <UpdateForm row={row} labels={labels} errors={errors} staff={staff} incidents={incidents} />
                </TableCell>
              </TableRow>
            ) : null}
          </Fragment>
        ))}
      </TableBody>
    </Table>
  );
}
