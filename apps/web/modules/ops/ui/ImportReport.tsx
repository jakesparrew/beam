"use client";
/**
 * The report block of `/admin/imports/[id]` (ops spec 5, rules 43a, 44, 48): live progress
 * (refreshes every 3 s while a run or dry run is in progress), the dry-run and run reports (row
 * numbers and codes only), the reconciliation of packages and memberships, the sign-off block,
 * and the run, cancel and download actions. Every string comes from the page.
 */
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Badge, Button } from "@beam/ui";
import { cancelImport, signOffReconciliation, startImport } from "@/modules/ops/imports/actions";
import type { Reconciliation } from "@/modules/ops/imports/reconcile";
import type { ImportReport as ImportReportJson, RunReport } from "@/modules/ops/imports/report";

export type ImportReportLabels = {
  status: string;
  dryRunTitle: string;
  runTitle: string;
  rowStatus: Record<"pending" | "imported" | "updated" | "skipped" | "error", string>;
  newPersons: string;
  matchedPersons: string;
  duplicates: string;
  invalidEmails: string;
  unknownProducts: string;
  suppressedSkipped: string;
  overCapacity: string;
  partial: string;
  reconciliation: string;
  unitsInFile: string;
  unitsGranted: string;
  difference: string;
  signedOff: string | null;
  run: string;
  cancel: string;
  signOff: string;
  note: string;
  downloadErrors: string;
  confirmNoSuppressionSource: string;
  confirmDifferentFile: string;
  errors: Record<string, string>;
  genericError: string;
  failed: string | null;
};

type Props = {
  importId: string;
  kind: string;
  status: "uploaded" | "dry_run" | "running" | "done" | "failed" | "cancelled";
  dryRunFinished: boolean;
  counts: Partial<Record<keyof ImportReportLabels["rowStatus"], number>>;
  rowCount: number;
  report: ImportReportJson;
  reconciliation: Reconciliation | null;
  canRun: boolean;
  canSignOff: boolean;
  signedOff: boolean;
  labels: ImportReportLabels;
};

function Rows({ label, rows }: { label: string; rows: number[] }) {
  if (!rows.length) return null;
  return (
    <li>
      <span className="font-medium">{label}</span>: {rows.length} ({rows.slice(0, 50).join(", ")}
      {rows.length > 50 ? ", …" : ""})
    </li>
  );
}

function RunBlock({ title, report, labels, testId }: { title: string; report: RunReport; labels: ImportReportLabels; testId: string }) {
  return (
    <section className="grid gap-2 rounded-md border p-4" data-testid={testId}>
      <h2 className="text-lg font-semibold">{title}</h2>
      <dl className="flex flex-wrap gap-4 text-sm">
        {(Object.keys(labels.rowStatus) as (keyof ImportReportLabels["rowStatus"])[]).map((s) => (
          <div key={s}>
            <dt className="text-muted-foreground">{labels.rowStatus[s]}</dt>
            <dd className="text-xl font-semibold" data-testid={`${testId}-${s}`}>
              {report.rows[s] ?? 0}
            </dd>
          </div>
        ))}
        <div>
          <dt className="text-muted-foreground">{labels.newPersons}</dt>
          <dd className="text-xl font-semibold">{report.new_persons}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{labels.matchedPersons}</dt>
          <dd className="text-xl font-semibold">{report.matched_persons}</dd>
        </div>
      </dl>
      <ul className="grid gap-1 text-sm">
        <Rows label={labels.duplicates} rows={report.duplicates_in_file} />
        <Rows label={labels.invalidEmails} rows={[...report.invalid_emails, ...report.missing_emails]} />
        <Rows label={labels.unknownProducts} rows={report.unknown_products} />
        <Rows label={labels.suppressedSkipped} rows={report.suppressed_skipped} />
        <Rows label={labels.overCapacity} rows={report.over_capacity} />
        {Object.entries(report.error_codes).map(([code, n]) => (
          <li key={code}>
            <span className="font-medium">{labels.errors[code] ?? code}</span>: {n}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function ImportReport({ importId, kind, status, dryRunFinished, counts, rowCount, report, reconciliation, canRun, canSignOff, signedOff, labels }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needs, setNeeds] = useState<{ suppressions?: boolean; differentFile?: boolean }>({});
  const [confirm, setConfirm] = useState<{ suppressions: boolean; differentFile: boolean }>({ suppressions: false, differentFile: false });
  const [note, setNote] = useState("");
  const inProgress = status === "running" || (status === "dry_run" && !dryRunFinished);

  useEffect(() => {
    if (!inProgress) return;
    const timer = setInterval(() => router.refresh(), 3000);
    return () => clearInterval(timer);
  }, [inProgress, router]);

  async function call<T>(fn: () => Promise<{ ok: true; data: T } | { ok: false; error: { code: string; message: string } }>) {
    setBusy(true);
    setError(null);
    try {
      const res = await fn();
      if (!res.ok) {
        if (res.error.message === "suppressions_first") setNeeds((n) => ({ ...n, suppressions: true }));
        if (res.error.message === "same_file") setNeeds((n) => ({ ...n, differentFile: true }));
        setError(labels.errors[res.error.message] ?? labels.genericError);
      } else router.refresh();
    } finally {
      setBusy(false);
    }
  }

  const processed = rowCount ? rowCount - (counts.pending ?? 0) : 0;
  return (
    <div className="grid gap-4" data-testid="import-report">
      <div className="flex flex-wrap items-center gap-3">
        <Badge variant={status === "failed" ? "destructive" : "secondary"} data-testid="import-status">
          {labels.status}
        </Badge>
        {inProgress ? (
          <div className="flex min-w-48 items-center gap-2" role="status">
            <div className="h-2 w-48 overflow-hidden rounded bg-muted">
              <div className="h-full bg-primary" style={{ width: `${rowCount ? Math.round((processed / rowCount) * 100) : 0}%` }} />
            </div>
            <span className="text-xs text-muted-foreground">
              {processed} / {rowCount}
            </span>
          </div>
        ) : null}
        {report.partial ? <span className="text-sm text-muted-foreground">{labels.partial}</span> : null}
        {labels.failed ? <span className="text-sm text-destructive">{labels.failed}</span> : null}
      </div>

      {report.dry_run ? <RunBlock title={labels.dryRunTitle} report={report.dry_run} labels={labels} testId="dry-run-report" /> : null}
      {report.run ? <RunBlock title={labels.runTitle} report={report.run} labels={labels} testId="run-report" /> : null}

      {reconciliation ? (
        <section className="grid gap-2 rounded-md border p-4" data-testid="reconciliation">
          <h2 className="text-lg font-semibold">{labels.reconciliation}</h2>
          <table className="text-sm">
            <thead>
              <tr className="text-left text-muted-foreground">
                <th className="pr-4" />
                <th className="pr-4">{labels.unitsInFile}</th>
                <th className="pr-4">{labels.unitsGranted}</th>
                <th>{labels.difference}</th>
              </tr>
            </thead>
            <tbody>
              {reconciliation.lines.map((l) => (
                <tr key={`${l.creditKind}-${l.productSku}`}>
                  <td className="pr-4">
                    {l.productSku ?? "-"} {l.creditKind ? `(${l.creditKind})` : ""} · {l.rows}
                  </td>
                  <td className="pr-4">{l.unitsInFile}</td>
                  <td className="pr-4">{l.unitsGranted}</td>
                  <td className={l.difference ? "text-destructive" : undefined}>{l.difference}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {reconciliation.mismatches.length ? (
            <p className="text-sm text-destructive">
              {labels.difference}: {reconciliation.mismatches.map((m) => `${m.row} (${m.expected} → ${m.balance})`).join(", ")}
            </p>
          ) : null}
          {labels.signedOff ? <p className="text-sm">{labels.signedOff}</p> : null}
          {canSignOff && status === "done" && !signedOff && (kind === "packages" || kind === "memberships") ? (
            <div className="grid max-w-md gap-2">
              <label className="grid gap-1 text-sm">
                <span className="font-medium">{labels.note}</span>
                <textarea name="note" className="rounded-md border p-2" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
              </label>
              <div>
                <Button type="button" disabled={busy || !note.trim()} onClick={() => void call(() => signOffReconciliation({ importId, note }))}>
                  {labels.signOff}
                </Button>
              </div>
            </div>
          ) : null}
        </section>
      ) : null}

      {needs.suppressions ? (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={confirm.suppressions} onChange={(e) => setConfirm((c) => ({ ...c, suppressions: e.target.checked }))} />
          {labels.confirmNoSuppressionSource}
        </label>
      ) : null}
      {needs.differentFile ? (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={confirm.differentFile} onChange={(e) => setConfirm((c) => ({ ...c, differentFile: e.target.checked }))} />
          {labels.confirmDifferentFile}
        </label>
      ) : null}
      {error ? (
        <p className="text-sm text-destructive" data-testid="import-error">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {canRun && ((status === "dry_run" && dryRunFinished) || status === "failed") ? (
          <Button type="button" disabled={busy} onClick={() => void call(() => startImport({ importId, confirmNoSuppressionSource: confirm.suppressions || undefined, confirmDifferentFile: confirm.differentFile || undefined }))}>
            {labels.run}
          </Button>
        ) : null}
        {status === "uploaded" || status === "dry_run" || status === "running" ? (
          <Button type="button" variant="outline" disabled={busy} onClick={() => void call(() => cancelImport({ importId }))}>
            {labels.cancel}
          </Button>
        ) : null}
        {report.dry_run || report.run ? (
          <a className="inline-flex h-9 items-center rounded-md border px-3 text-sm" href={`/admin/imports/${importId}/rows.csv`} download>
            {labels.downloadErrors}
          </a>
        ) : null}
      </div>
    </div>
  );
}
