"use client";
/**
 * The manual-status UI of the 360 page (crm rules 3.9 and 3.11). `OverrideBanner` shows "Manual
 * status X differs from calculated Y" with "Keep" (`confirmStatusOverride`, hides the banner
 * until the derived status changes) and "Clear override" (`setStatusOverride` with `null` and a
 * reason). `StatusOverrideForm` sets or clears the manual status with a reason of 3 to 500
 * characters. Every string is a prop.
 */
import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent } from "react";
import { Alert, AlertDescription, Button, Input, Label } from "@beam/ui";
import type { PersonStatus } from "@beam/core/crm";
import { confirmStatusOverride, setStatusOverride } from "../../persons/actions";

export type OverrideBannerLabels = { message: string; keep: string; clear: string; reason: string; error: string };

export function OverrideBanner({ personId, labels }: { personId: string; labels: OverrideBannerLabels }) {
  const router = useRouter();
  const id = useId();
  const [clearing, setClearing] = useState(false);
  const [reason, setReason] = useState("");
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
    <Alert data-testid="override-banner" className="border-warning">
      <AlertDescription className="grid gap-3">
        <p className="font-medium">{labels.message}</p>
        <div className="flex flex-wrap items-end gap-2">
          <Button type="button" size="sm" disabled={busy} onClick={() => void run(() => confirmStatusOverride({ personId }))}>
            {labels.keep}
          </Button>
          {clearing ? (
            <form
              className="flex flex-wrap items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void run(() => setStatusOverride({ personId, status: null, reason }));
              }}
            >
              <div className="grid gap-1">
                <Label htmlFor={`${id}-reason`}>{labels.reason}</Label>
                <Input id={`${id}-reason`} value={reason} minLength={3} maxLength={500} required onChange={(e) => setReason(e.target.value)} />
              </div>
              <Button type="submit" size="sm" variant="outline" disabled={busy || reason.trim().length < 3}>
                {labels.clear}
              </Button>
            </form>
          ) : (
            <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => setClearing(true)}>
              {labels.clear}
            </Button>
          )}
        </div>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
      </AlertDescription>
    </Alert>
  );
}

export type StatusOverrideFormLabels = { title: string; status: string; none: string; reason: string; save: string; error: string; statuses: Record<PersonStatus, string> };

export function StatusOverrideForm({ personId, current, labels }: { personId: string; current: PersonStatus | null; labels: StatusOverrideFormLabels }) {
  const router = useRouter();
  const id = useId();
  const [status, setStatus] = useState<string>(current ?? "");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const result = await setStatusOverride({ personId, status: status ? (status as PersonStatus) : null, reason });
    setBusy(false);
    if (!result.ok) setError(labels.error);
    else {
      setReason("");
      router.refresh();
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="grid gap-3" data-testid="status-override-form" aria-label={labels.title}>
      <div className="grid gap-1">
        <Label htmlFor={`${id}-status`}>{labels.status}</Label>
        <select id={`${id}-status`} className="h-9 rounded-md border bg-background px-2 text-sm" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">{labels.none}</option>
          {(Object.keys(labels.statuses) as PersonStatus[]).map((s) => (
            <option key={s} value={s}>
              {labels.statuses[s]}
            </option>
          ))}
        </select>
      </div>
      <div className="grid gap-1">
        <Label htmlFor={`${id}-reason`}>{labels.reason}</Label>
        <Input id={`${id}-reason`} value={reason} minLength={3} maxLength={500} required onChange={(e) => setReason(e.target.value)} />
      </div>
      <div>
        <Button type="submit" size="sm" disabled={busy || reason.trim().length < 3}>
          {labels.save}
        </Button>
      </div>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </form>
  );
}
