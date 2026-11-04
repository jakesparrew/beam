"use client";
/**
 * One monthly SLA report (`/admin/system/reports/[id]`, PL-89, PL-89a): uptime (red below
 * 99.5 %), downtime, incidents, support per severity with breaches, dead jobs, alerts, backups,
 * restore drill, AI spend and sizes. A draft takes notes and a manual uptime (when Better Stack
 * failed) and is sent by an owner or technical_admin; a sent report is read-only.
 */
import { useState } from "react";
import { Badge, Button, FormField, Input, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, Textarea } from "@beam/ui";
import { sendMonthlyReport, updateMonthlyReport } from "../actions";
import { Feedback, lab, useRun, type Labels } from "./settings-form";

export type MonthlyReportViewData = {
  id: string;
  monthOn: string;
  status: "draft" | "sent";
  notes: string;
  sentAt: string | null;
  sentBy: string | null;
  data: {
    uptime_pct: number | null;
    downtime_minutes: number | null;
    uptime_source: "betterstack" | "manual";
    incidents: { critical: number; high: number; normal: number };
    support: { per_severity: Record<string, { received: number; resolved: number; median_first_response_minutes: number | null; breaches: number }> };
    dead_jobs: number;
    alerts_sent: number;
    backups_ok: number;
    backups_failed: number;
    restore_drill: { at: string; ok: boolean } | null;
    ai_spend_cents: number;
    db_size_bytes: number;
    files_size_bytes: number;
  };
};

const TARGET = 99.5;
const SEVERITIES = ["critical", "high", "normal", "improvement"];

export function MonthlyReportView({ report, canEdit, locale, labels, errors }: { report: MonthlyReportViewData; canEdit: boolean; locale: string; labels: Labels; errors: Labels }) {
  const d = report.data;
  const [notes, setNotes] = useState(report.notes);
  const [uptime, setUptime] = useState(d.uptime_pct === null ? "" : String(d.uptime_pct));
  const r = useRun(errors);
  const editable = canEdit && report.status === "draft";
  const num = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 });
  const money = new Intl.NumberFormat(locale, { style: "currency", currency: "EUR" });
  const mb = (b: number) => `${num.format(b / 1024 ** 2)} MB`;
  const below = d.uptime_pct !== null && d.uptime_pct < TARGET;
  const facts: [string, string][] = [
    [lab(labels, "downtime"), d.downtime_minutes === null ? "–" : lab(labels, "minutes", { n: d.downtime_minutes })],
    [lab(labels, "uptime_source"), lab(labels, `source_${d.uptime_source}`)],
    [lab(labels, "incidents"), `${d.incidents.critical} / ${d.incidents.high} / ${d.incidents.normal}`],
    [lab(labels, "dead_jobs"), String(d.dead_jobs)],
    [lab(labels, "alerts_sent"), String(d.alerts_sent)],
    [lab(labels, "backups"), lab(labels, "backups_value", { ok: d.backups_ok, failed: d.backups_failed })],
    [lab(labels, "restore_drill"), d.restore_drill ? `${new Date(d.restore_drill.at).toLocaleDateString(locale)} · ${lab(labels, d.restore_drill.ok ? "ok" : "failed")}` : "–"],
    [lab(labels, "ai_spend"), money.format(d.ai_spend_cents / 100)],
    [lab(labels, "db_size"), mb(d.db_size_bytes)],
    [lab(labels, "files_size"), mb(d.files_size_bytes)],
  ];
  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <p className={below ? "text-3xl font-semibold text-destructive" : "text-3xl font-semibold"} data-uptime-below={below}>
          {d.uptime_pct === null ? "–" : `${num.format(d.uptime_pct)} %`}
        </p>
        {below ? <Badge variant="destructive">{lab(labels, "below_target")}</Badge> : <Badge variant="success">{lab(labels, "on_target")}</Badge>}
        <Badge variant={report.status === "sent" ? "secondary" : "warning"}>{lab(labels, `status_${report.status}`)}</Badge>
      </div>
      <dl className="grid gap-2 sm:grid-cols-2">
        {facts.map(([k, v]) => (
          <div key={k} className="flex justify-between gap-4 border-b py-1 text-sm">
            <dt className="text-muted-foreground">{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{lab(labels, "severity")}</TableHead>
            <TableHead>{lab(labels, "received")}</TableHead>
            <TableHead>{lab(labels, "resolved")}</TableHead>
            <TableHead>{lab(labels, "median_response")}</TableHead>
            <TableHead>{lab(labels, "breaches")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {SEVERITIES.map((s) => {
            const row = d.support.per_severity[s] ?? { received: 0, resolved: 0, median_first_response_minutes: null, breaches: 0 };
            return (
              <TableRow key={s}>
                <TableCell>{lab(labels, `severity_${s}`)}</TableCell>
                <TableCell>{row.received}</TableCell>
                <TableCell>{row.resolved}</TableCell>
                <TableCell>{row.median_first_response_minutes === null ? "–" : lab(labels, "minutes", { n: row.median_first_response_minutes })}</TableCell>
                <TableCell className={row.breaches > 0 ? "text-destructive" : undefined}>{row.breaches}</TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      {report.status === "sent" ? (
        <p className="text-sm text-muted-foreground">{lab(labels, "sent_by", { who: report.sentBy ?? "–", when: report.sentAt ? new Date(report.sentAt).toLocaleString(locale) : "–" })}</p>
      ) : null}
      <div className="grid max-w-2xl gap-3">
        <FormField label={lab(labels, "notes")}>
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={4} readOnly={!editable} />
        </FormField>
        {editable ? (
          <FormField label={lab(labels, "manual_uptime")} hint={lab(labels, "manual_uptime_hint")}>
            <Input type="number" step="0.01" min={0} max={100} value={uptime} onChange={(e) => setUptime(e.target.value)} />
          </FormField>
        ) : null}
        <Feedback ok={r.ok} error={r.error} />
        {editable ? (
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={r.pending}
              onClick={() =>
                void r.run(
                  () => updateMonthlyReport({ id: report.id, notes, ...(uptime !== "" && Number(uptime) !== d.uptime_pct ? { uptimePct: Number(uptime) } : {}) }),
                  lab(labels, "saved"),
                )
              }
            >
              {lab(labels, "save")}
            </Button>
            <Button type="button" disabled={r.pending} onClick={() => void r.run(() => sendMonthlyReport({ id: report.id }), lab(labels, "sent"))}>
              {lab(labels, "send")}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
