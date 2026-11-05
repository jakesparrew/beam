"use client";

/**
 * The source page's tools (forms spec section 5 `/admin/forms/imports/[sourceId]`; forms-P7,
 * rules I1, I4 and I5): `ImportSourceActions` rotates the secret (the new URL is shown once) and
 * uploads a CSV backfill (max 2 MB); `ImportEventsTable` lists the events with received time,
 * status, skip reason and the submission link, and reprocesses a failed or skipped event. No
 * payload is ever sent to the browser.
 */
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Badge, Button, EmptyState, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, toast } from "@beam/ui";
import { reprocessImportEvent, rotateImportSecret, uploadImportCsv } from "../../actions";
import type { ImportEventRow, ImportEventStatus } from "../../queries";
import { lbl, type Labels } from "./issues-panel";

const MAX_CSV_BYTES = 2 * 1024 * 1024;

const errorText = (labels: Labels, e: { code: string; message: string }): string =>
  labels[`imports.error.${e.message}`] ?? labels[`imports.error.${e.code}`] ?? lbl(labels, "imports.error.internal");

export function ImportSourceActions({ sourceId, labels }: { sourceId: string; labels: Labels }) {
  const router = useRouter();
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const rotate = async () => {
    if (!window.confirm(lbl(labels, "imports.rotate_confirm"))) return;
    setBusy(true);
    const r = await rotateImportSecret({ sourceId });
    setBusy(false);
    if (r.ok) {
      setUrl(r.data.url);
      toast.success(lbl(labels, "imports.rotated"));
    } else toast.error(errorText(labels, r.error));
  };

  const upload = async (file: File) => {
    setResult(null);
    if (file.size > MAX_CSV_BYTES) {
      toast.error(lbl(labels, "imports.error.csv_too_large"));
      return;
    }
    setBusy(true);
    const r = await uploadImportCsv({ sourceId, csv: await file.text() });
    setBusy(false);
    if (r.ok) {
      setResult(lbl(labels, "imports.csv_result", { inserted: r.data.inserted, duplicates: r.data.duplicates }));
      router.refresh();
    } else toast.error(errorText(labels, r.error));
  };

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" variant="outline" disabled={busy} onClick={() => void rotate()}>
          {lbl(labels, "imports.rotate")}
        </Button>
        <label className="flex items-center gap-2 text-sm">
          <span className="font-medium">{lbl(labels, "imports.upload_csv")}</span>
          <input
            type="file"
            accept=".csv,text/csv"
            aria-label={lbl(labels, "imports.csv_file")}
            disabled={busy}
            className="text-sm"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) void upload(f);
            }}
          />
        </label>
      </div>
      <p className="text-xs text-muted-foreground">{lbl(labels, "imports.csv_help")}</p>
      {result ? (
        <p role="status" className="text-sm">
          {result}
        </p>
      ) : null}
      {url ? (
        <div className="grid gap-2 rounded-md border border-warning p-3" role="status">
          <p className="text-sm font-medium">{lbl(labels, "imports.secret_once")}</p>
          <code className="break-all rounded bg-muted p-2 text-sm">{url}</code>
          <div className="flex gap-2">
            <Button type="button" size="sm" variant="outline" onClick={() => void navigator.clipboard?.writeText(url).then(() => toast.success(lbl(labels, "imports.copied")))}>
              {lbl(labels, "imports.copy")}
            </Button>
            <Button type="button" size="sm" onClick={() => setUrl(null)}>
              {lbl(labels, "imports.done")}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

const VARIANT: Record<ImportEventStatus, "secondary" | "success" | "warning" | "destructive"> = {
  received: "secondary",
  processed: "success",
  skipped: "warning",
  failed: "destructive",
};

export type ImportEventsTableProps = {
  formId: string;
  rows: ImportEventRow[];
  labels: Labels;
  /** Received and processed times, formatted on the server in the staff locale. */
  times: Record<string, { receivedAt: string; processedAt: string | null }>;
};

export function ImportEventsTable({ formId, rows, labels, times }: ImportEventsTableProps) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  if (!rows.length) return <EmptyState title={lbl(labels, "imports.no_events")} />;
  const reason = (e: string | null) => (e ? (labels[`imports.skip.${e}`] ?? e) : "");
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{lbl(labels, "imports.received_at")}</TableHead>
          <TableHead>{lbl(labels, "imports.status")}</TableHead>
          <TableHead>{lbl(labels, "imports.reason")}</TableHead>
          <TableHead>{lbl(labels, "imports.submission")}</TableHead>
          <TableHead />
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={r.id}>
            <TableCell className="whitespace-nowrap text-sm">{times[r.id]?.receivedAt ?? ""}</TableCell>
            <TableCell>
              <Badge variant={VARIANT[r.status]}>{lbl(labels, `imports.status_${r.status}`)}</Badge>
            </TableCell>
            <TableCell className="text-sm">{reason(r.error)}</TableCell>
            <TableCell>
              {r.submissionId ? (
                <Link className="text-sm underline" href={`/admin/forms/${formId}/submissions/${r.submissionId}`}>
                  {lbl(labels, "imports.view_submission")}
                </Link>
              ) : null}
            </TableCell>
            <TableCell className="text-right">
              {r.status === "failed" || r.status === "skipped" ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busy === r.id}
                  onClick={() => {
                    void (async () => {
                      setBusy(r.id);
                      const res = await reprocessImportEvent({ eventId: r.id });
                      setBusy(null);
                      if (res.ok) {
                        toast.success(lbl(labels, "imports.reprocessed"));
                        router.refresh();
                      } else toast.error(errorText(labels, res.error));
                    })();
                  }}
                >
                  {lbl(labels, "imports.reprocess")}
                </Button>
              ) : null}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
