"use client";
/**
 * Audit search (`/admin/system/audit`): filters in the URL (actor from the staff list, action,
 * entity type and id, person id, date range), rows that expand to the old and new JSON, keyset
 * "next page" link and the CSV export of the filtered result (audited `audit.export`).
 */
import { Fragment, useState } from "react";
import { Button, FormField, Input, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@beam/ui";
import { exportAuditCsv } from "../actions";
import { Feedback, lab, useRun, type Labels } from "./settings-form";

export type AuditFilters = { actorId?: string; action?: string; entityType?: string; entityId?: string; personId?: string; from?: string; to?: string };
export type AuditRowView = { id: string; actor: string; action: string; entityType: string; entityId: string | null; personId: string | null; oldValue: unknown; newValue: unknown; createdAt: string };

export function AuditSearchForm({ filters, staff, labels }: { filters: AuditFilters; staff: { id: string; name: string }[]; labels: Labels }) {
  return (
    <form method="get" className="grid gap-3 rounded-md border p-4 sm:grid-cols-4" role="search" aria-label={lab(labels, "filters")}>
      <FormField label={lab(labels, "actor")}>
        <select name="actorId" defaultValue={filters.actorId ?? ""} className="h-9 rounded-md border bg-background px-2 text-sm">
          <option value="">{lab(labels, "any")}</option>
          {staff.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </FormField>
      <FormField label={lab(labels, "action")} hint={lab(labels, "action_hint")}>
        <Input name="action" defaultValue={filters.action ?? ""} />
      </FormField>
      <FormField label={lab(labels, "entity_type")}>
        <Input name="entityType" defaultValue={filters.entityType ?? ""} />
      </FormField>
      <FormField label={lab(labels, "entity_id")}>
        <Input name="entityId" defaultValue={filters.entityId ?? ""} />
      </FormField>
      <FormField label={lab(labels, "person_id")}>
        <Input name="personId" defaultValue={filters.personId ?? ""} className="font-mono text-xs" />
      </FormField>
      <FormField label={lab(labels, "from")}>
        <Input name="from" type="date" defaultValue={filters.from ?? ""} />
      </FormField>
      <FormField label={lab(labels, "to")}>
        <Input name="to" type="date" defaultValue={filters.to ?? ""} />
      </FormField>
      <div className="flex items-end">
        <Button type="submit">{lab(labels, "apply")}</Button>
      </div>
    </form>
  );
}

const json = (v: unknown) => (v === null || v === undefined ? "–" : JSON.stringify(v, null, 2));

export function AuditResults({ rows, locale, labels }: { rows: AuditRowView[]; locale: string; labels: Labels }) {
  const [open, setOpen] = useState<string | null>(null);
  const fmt = new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "medium", timeZone: "Europe/Brussels" });
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{lab(labels, "col_when")}</TableHead>
          <TableHead>{lab(labels, "actor")}</TableHead>
          <TableHead>{lab(labels, "action")}</TableHead>
          <TableHead>{lab(labels, "entity_type")}</TableHead>
          <TableHead>{lab(labels, "entity_id")}</TableHead>
          <TableHead>{lab(labels, "col_details")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <Fragment key={r.id}>
            <TableRow data-audit-action={r.action}>
              <TableCell>{fmt.format(new Date(r.createdAt))}</TableCell>
              <TableCell>{r.actor}</TableCell>
              <TableCell className="font-mono text-xs">{r.action}</TableCell>
              <TableCell>{r.entityType}</TableCell>
              <TableCell className="font-mono text-xs">{r.entityId ?? "–"}</TableCell>
              <TableCell>
                <Button type="button" size="sm" variant="outline" aria-expanded={open === r.id} onClick={() => setOpen(open === r.id ? null : r.id)}>
                  {lab(labels, open === r.id ? "hide" : "show")}
                </Button>
              </TableCell>
            </TableRow>
            {open === r.id ? (
              <TableRow>
                <TableCell colSpan={6}>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div>
                      <p className="text-xs font-semibold">{lab(labels, "old_value")}</p>
                      <pre className="max-h-80 overflow-auto rounded bg-muted p-2 text-xs">{json(r.oldValue)}</pre>
                    </div>
                    <div>
                      <p className="text-xs font-semibold">{lab(labels, "new_value")}</p>
                      <pre className="max-h-80 overflow-auto rounded bg-muted p-2 text-xs">{json(r.newValue)}</pre>
                    </div>
                  </div>
                </TableCell>
              </TableRow>
            ) : null}
          </Fragment>
        ))}
      </TableBody>
    </Table>
  );
}

export function AuditExportButton({ filters, labels, errors }: { filters: AuditFilters; labels: Labels; errors: Labels }) {
  const r = useRun(errors);
  return (
    <div className="grid gap-2">
      <div>
        <Button
          type="button"
          variant="outline"
          disabled={r.pending}
          onClick={() =>
            void r.run(
              () => exportAuditCsv(filters),
              lab(labels, "exported"),
              (data) => {
                const url = URL.createObjectURL(new Blob([data.csv], { type: "text/csv;charset=utf-8" }));
                const a = document.createElement("a");
                a.href = url;
                a.download = data.filename;
                a.click();
                URL.revokeObjectURL(url);
              },
            )
          }
        >
          {lab(labels, "export_csv")}
        </Button>
      </div>
      <Feedback ok={r.ok} error={r.error} />
    </div>
  );
}
