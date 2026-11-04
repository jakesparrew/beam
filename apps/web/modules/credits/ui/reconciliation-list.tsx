"use client";
/**
 * `/admin/credits/reconciliation` (credits spec section 5): the last 30 `ledger.reconcile` runs
 * with status, counts and findings (links to grants and memberships), and "Run now"
 * (`requestReconcile`, `credits.adjust`). The page formats every row; this component renders it.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Alert, AlertDescription, Badge, Button, EmptyState, Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@beam/ui";
import { requestReconcile } from "../actions";
import { errorMessage, type Labels } from "./adjust-dialog";

export type ReconcileRunView = {
  id: string;
  startedText: string;
  status: "ok" | "mismatch" | "error" | "running";
  statusText: string;
  checkedGrants: number;
  checkedBookings: number;
  fixedText: string | null;
  findings: { text: string; grantId?: string; membershipId?: string; bookingId?: string }[];
};

export function RunReconcileButton({ labels: l }: { labels: Labels }) {
  const router = useRouter();
  const [state, setState] = useState<{ error?: string; done?: boolean }>({});
  const [busy, setBusy] = useState(false);
  async function run() {
    setBusy(true);
    setState({});
    try {
      const r = await requestReconcile({});
      if (r.ok) {
        setState({ done: true });
        router.refresh();
      } else setState({ error: errorMessage(r.error, l) });
    } catch {
      setState({ error: l["errors.generic"] });
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="grid gap-2">
      <div>
        <Button onClick={() => void run()} disabled={busy}>
          {l["admin.reconciliation.run"]}
        </Button>
      </div>
      {state.done ? (
        <Alert role="status">
          <AlertDescription>{l["admin.reconciliation.requested"]}</AlertDescription>
        </Alert>
      ) : null}
      {state.error ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}

const variant = (s: ReconcileRunView["status"]) => (s === "ok" ? "success" : s === "running" ? "outline" : s === "mismatch" ? "warning" : "destructive");

export function ReconciliationList({ runs, labels: l }: { runs: ReconcileRunView[]; labels: Labels }) {
  const r = (k: string) => l[`admin.reconciliation.${k}`] ?? k;
  if (runs.length === 0) return <EmptyState title={r("empty")} />;
  return (
    <Table>
      <TableCaption>{r("caption")}</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead>{r("col_started")}</TableHead>
          <TableHead>{r("col_status")}</TableHead>
          <TableHead className="text-right">{r("col_grants")}</TableHead>
          <TableHead className="text-right">{r("col_bookings")}</TableHead>
          <TableHead>{r("col_findings")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {runs.map((run) => (
          <TableRow key={run.id}>
            <TableCell className="whitespace-nowrap">{run.startedText}</TableCell>
            <TableCell>
              <Badge variant={variant(run.status)}>{run.statusText}</Badge>
            </TableCell>
            <TableCell className="text-right tabular-nums">{run.checkedGrants}</TableCell>
            <TableCell className="text-right tabular-nums">{run.checkedBookings}</TableCell>
            <TableCell>
              {run.findings.length === 0 ? (
                <span className="text-sm text-muted-foreground">{r("no_findings")}</span>
              ) : (
                <ul className="grid gap-1 text-sm">
                  {run.findings.map((f, i) => (
                    <li key={i}>
                      {f.text}
                      {f.grantId ? (
                        <>
                          {" · "}
                          <Link href={`/admin/credits/grants/${f.grantId}`} className="underline-offset-4 hover:underline">
                            {r("grant_link")}
                          </Link>
                        </>
                      ) : null}
                      {f.membershipId ? (
                        <>
                          {" · "}
                          <Link href={`/admin/memberships/${f.membershipId}`} className="underline-offset-4 hover:underline">
                            {r("membership_link")}
                          </Link>
                        </>
                      ) : null}
                      {f.bookingId ? <span className="text-muted-foreground">{` · ${r("booking_link")} ${f.bookingId.slice(0, 8)}`}</span> : null}
                    </li>
                  ))}
                </ul>
              )}
              {run.fixedText ? <p className="mt-1 text-xs text-muted-foreground">{run.fixedText}</p> : null}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
