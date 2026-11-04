"use client";
/**
 * Staff consent UI (crm spec 5.1). `ConsentPanel` is the 360 panel: consents per purpose with
 * history and the address's suppressions, a staff consent change (grants only `b2b` on legitimate
 * interest, withdrawals of any purpose) and "unsubscribe from all marketing" (a manual `all`
 * suppression). `ConsentWordingPublisher` is the publish form of `/admin/persons/consent-wordings`
 * (all three locales required). Every string is a prop.
 */
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, LocalizedInput, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@beam/ui";
import type { ConsentPurpose } from "@beam/core/crm";
import { addManualSuppression, publishConsentWording, recordStaffConsent } from "../consent/actions";

export type ConsentPanelView = {
  personId: string;
  email: string | null;
  canWrite: boolean;
  purposes: Array<{ purpose: ConsentPurpose; label: string; status: "granted" | "withdrawn" | null; method: string | null; recordedAt: string | null; reachable: boolean | null }>;
  history: Array<{ id: string; purposeLabel: string; statusLabel: string; methodLabel: string; source: string; wordingVersion: string; recordedAt: string }>;
  suppressions: Array<{ id: string; scopeLabel: string; reasonLabel: string; createdAt: string }>;
};

export type ConsentPanelLabels = {
  title: string;
  history: string;
  suppressions: string;
  none: string;
  granted: string;
  withdrawn: string;
  notRecorded: string;
  reachable: string;
  unreachable: string;
  grant: string;
  withdraw: string;
  unsubscribeAll: string;
  unsubscribeAllNote: string;
  error: string;
  columns: { purpose: string; status: string; method: string; source: string; version: string; date: string; scope: string; reason: string };
};

export function ConsentPanel({ view, labels }: { view: ConsentPanelView; labels: ConsentPanelLabels }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(call: () => Promise<{ ok: boolean }>) {
    setBusy(true);
    setError(null);
    const result = await call();
    setBusy(false);
    if (!result.ok) setError(labels.error);
    else router.refresh();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{labels.title}</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-6">
        <ul className="grid gap-2">
          {view.purposes.map((p) => (
            <li key={p.purpose} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{p.label}</span>
                <Badge variant={p.status === "granted" ? "default" : "secondary"}>{p.status === "granted" ? labels.granted : p.status === "withdrawn" ? labels.withdrawn : labels.notRecorded}</Badge>
                {p.reachable === null ? null : <Badge variant="outline">{p.reachable ? labels.reachable : labels.unreachable}</Badge>}
                {p.recordedAt ? <span className="text-xs text-muted-foreground">{p.recordedAt}</span> : null}
              </div>
              {view.canWrite ? (
                <div className="flex gap-2">
                  {p.purpose === "b2b" && p.status !== "granted" ? (
                    <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(() => recordStaffConsent({ personId: view.personId, purpose: p.purpose, status: "granted" }))}>
                      {labels.grant}
                    </Button>
                  ) : null}
                  {p.status === "granted" ? (
                    <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(() => recordStaffConsent({ personId: view.personId, purpose: p.purpose, status: "withdrawn" }))}>
                      {labels.withdraw}
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
        {view.canWrite && view.email ? (
          <div>
            <Button
              variant="destructive"
              size="sm"
              disabled={busy}
              onClick={() => void run(() => addManualSuppression({ email: view.email, scope: "all", note: labels.unsubscribeAllNote }))}
            >
              {labels.unsubscribeAll}
            </Button>
          </div>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <section className="grid gap-2">
          <h3 className="text-sm font-semibold">{labels.history}</h3>
          {view.history.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{labels.columns.date}</TableHead>
                  <TableHead>{labels.columns.purpose}</TableHead>
                  <TableHead>{labels.columns.status}</TableHead>
                  <TableHead>{labels.columns.method}</TableHead>
                  <TableHead>{labels.columns.source}</TableHead>
                  <TableHead>{labels.columns.version}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {view.history.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell>{r.recordedAt}</TableCell>
                    <TableCell>{r.purposeLabel}</TableCell>
                    <TableCell>{r.statusLabel}</TableCell>
                    <TableCell>{r.methodLabel}</TableCell>
                    <TableCell className="font-mono text-xs">{r.source}</TableCell>
                    <TableCell className="font-mono text-xs">{r.wordingVersion}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <p className="text-sm text-muted-foreground">{labels.none}</p>
          )}
        </section>
        <section className="grid gap-2">
          <h3 className="text-sm font-semibold">{labels.suppressions}</h3>
          {view.suppressions.length ? (
            <ul className="grid gap-1 text-sm">
              {view.suppressions.map((s) => (
                <li key={s.id}>
                  {s.createdAt}: {s.scopeLabel} ({s.reasonLabel})
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">{labels.none}</p>
          )}
        </section>
      </CardContent>
    </Card>
  );
}

export type ConsentWordingPublisherLabels = {
  publish: string;
  confirm: string;
  published: string;
  error: string;
  missing: string;
  field: string;
  complete: string;
  locales: Record<"nl-BE" | "fr-BE" | "en", string>;
};

export function ConsentWordingPublisher({ purpose, initial, labels }: { purpose: ConsentPurpose; initial: Partial<Record<"nl-BE" | "fr-BE" | "en", string>>; labels: ConsentWordingPublisherLabels }) {
  const router = useRouter();
  const [text, setText] = useState(initial);
  const [status, setStatus] = useState<{ kind: "idle" | "saving" | "done" | "error"; message?: string }>({ kind: "idle" });

  async function publish() {
    if (!window.confirm(labels.confirm)) return;
    setStatus({ kind: "saving" });
    const result = await publishConsentWording({ purpose, text });
    if (!result.ok) {
      setStatus({ kind: "error", message: result.error.fields?.text ? `${labels.error} (${result.error.fields.text})` : labels.error });
      return;
    }
    setStatus({ kind: "done", message: labels.published.replace("{version}", String(result.data.version)) });
    router.refresh();
  }

  return (
    <div className="grid gap-3">
      <LocalizedInput
        name={`wording-${purpose}`}
        value={text}
        onChange={(v) => setText(v)}
        locales={["nl-BE", "fr-BE", "en"] as const}
        multiline
        labels={{ field: labels.field, locales: labels.locales, missing: labels.missing, complete: labels.complete }}
      />
      <div>
        <Button type="button" onClick={() => void publish()} disabled={status.kind === "saving"}>
          {labels.publish}
        </Button>
      </div>
      <p aria-live="polite" role="status" className={status.kind === "error" ? "text-sm text-destructive" : "text-sm"}>
        {status.message ?? ""}
      </p>
    </div>
  );
}
