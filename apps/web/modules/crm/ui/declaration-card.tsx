"use client";
/**
 * Guardian consent card (crm rule 3.54, spec 5.1): the person's guardian-consent history with
 * its validity, "record consent" (reception, the current published version, with the guardian
 * person) and "revoke consent" with a reason. Every string is a prop.
 */
import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Input } from "@beam/ui";
import { recordDeclaration, revokeDeclaration } from "../declarations/actions";

export type DeclarationCardView = {
  personId: string;
  isMinor: boolean;
  isValid: boolean;
  /** Status of the latest row; an accepted latest row that is not valid needs a new consent (new version). */
  latestStatus: "accepted" | "revoked" | null;
  canWrite: boolean;
  publishedVersion: number | null;
  rows: Array<{ id: string; statusLabel: string; methodLabel: string; versionLabel: string; acceptedOn: string; guardianName: string | null }>;
  guardianOptions: Array<{ id: string; name: string }>;
};

export type DeclarationCardLabels = {
  title: string;
  record: string;
  revoke: string;
  revokeReason: string;
  guardian: string;
  guardianId: string;
  valid: string;
  invalid: string;
  none: string;
  nonePublished: string;
  minorNotice: string;
  reacceptance: string;
  method: string;
  error: string;
};

export function DeclarationCard({ view, labels }: { view: DeclarationCardView; labels: DeclarationCardLabels }) {
  const router = useRouter();
  const id = useId();
  const [guardian, setGuardian] = useState(view.guardianOptions[0]?.id ?? "");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(call: () => Promise<{ ok: boolean }>) {
    setBusy(true);
    setError(null);
    const result = await call();
    setBusy(false);
    if (!result.ok) setError(labels.error);
    else {
      setReason("");
      router.refresh();
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle>{labels.title}</CardTitle>
        <Badge variant={view.isValid ? "default" : "secondary"}>{view.isValid ? labels.valid : labels.invalid}</Badge>
      </CardHeader>
      <CardContent className="grid gap-4">
        {view.isMinor && !view.isValid ? <p className="text-sm font-medium">{labels.minorNotice}</p> : null}
        {!view.isValid && view.latestStatus === "accepted" ? <p className="text-sm text-muted-foreground">{labels.reacceptance}</p> : null}
        {view.rows.length ? (
          <ul className="grid gap-2 text-sm">
            {view.rows.map((r) => (
              <li key={r.id} className="flex flex-wrap gap-2">
                <Badge variant="outline">{r.statusLabel}</Badge>
                <span>{r.versionLabel}</span>
                <span>{r.acceptedOn}</span>
                <span>
                  {labels.method}: {r.methodLabel}
                </span>
                {r.guardianName ? (
                  <span>
                    {labels.guardian}: {r.guardianName}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">{labels.none}</p>
        )}
        {view.canWrite ? (
          view.publishedVersion === null ? (
            <p className="text-sm text-muted-foreground">{labels.nonePublished}</p>
          ) : (
            <div className="grid gap-3">
              <label htmlFor={`${id}-guardian`} className="grid gap-1 text-sm font-medium">
                {view.guardianOptions.length ? labels.guardian : labels.guardianId}
                {view.guardianOptions.length ? (
                  <select id={`${id}-guardian`} className="h-9 rounded-md border border-input bg-background px-3 text-sm" value={guardian} onChange={(e) => setGuardian(e.target.value)}>
                    {view.guardianOptions.map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.name}
                      </option>
                    ))}
                  </select>
                ) : (
                  <Input id={`${id}-guardian`} value={guardian} onChange={(e) => setGuardian(e.target.value.trim())} />
                )}
              </label>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" disabled={busy || !guardian} onClick={() => void run(() => recordDeclaration({ personId: view.personId, kind: "guardian_consent", guardianPersonId: guardian }))}>
                  {labels.record}
                </Button>
              </div>
              {view.isValid ? (
                <div className="grid gap-2">
                  <label htmlFor={`${id}-reason`} className="grid gap-1 text-sm font-medium">
                    {labels.revokeReason}
                    <Input id={`${id}-reason`} value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
                  </label>
                  <div>
                    <Button size="sm" variant="outline" disabled={busy || reason.trim().length < 3} onClick={() => void run(() => revokeDeclaration({ personId: view.personId, kind: "guardian_consent", reason }))}>
                      {labels.revoke}
                    </Button>
                  </div>
                </div>
              ) : null}
            </div>
          )
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
