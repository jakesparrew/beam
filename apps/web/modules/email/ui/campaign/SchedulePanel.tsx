"use client";
/**
 * The Schedule step (email spec rule 26, section 5): a date and time in Brussels or "Send now".
 * A time outside 08:00-21:00, on a Sunday or on a Belgian public holiday is a warning that needs
 * the "send anyway" confirmation; every other failed check comes back from `scheduleCampaign` as
 * a `validation` list and is shown item by item.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Alert, AlertDescription, AlertTitle, Button, Checkbox, Input, Label } from "@beam/ui";
import { brusselsInstant, sendWindowWarnings } from "@beam/core/email";
import { scheduleCampaign } from "../../actions";
import { clab, type CampaignLabels } from "./CampaignStepper";

export type SchedulePanelProps = {
  campaignId: string;
  version: number;
  /** `YYYY-MM-DDTHH:mm` in Brussels, the draft's `scheduled_at` or a suggestion. */
  initialLocal: string;
  canSchedule: boolean;
  labels: CampaignLabels;
};

/** `YYYY-MM-DDTHH:mm` read as Brussels wall-clock time. */
export function brusselsFromLocal(value: string): Date | null {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/.exec(value);
  return m ? brusselsInstant(m[1]!, Number(m[2]), Number(m[3])) : null;
}

/** The text of one failed check of a `validation` answer (`field: code`). */
function failureText(labels: CampaignLabels, field: string, code: string): string {
  if (field.startsWith("locale:")) return `${field.slice(7)}: ${clab(labels, "errors.missing_locale")}`;
  const key = code.startsWith("outside_window") ? "errors.outside_window" : `errors.${code}`;
  return labels[key] ?? `${field}: ${code}`;
}

export function SchedulePanel(props: SchedulePanelProps) {
  const { labels } = props;
  const router = useRouter();
  const [local, setLocal] = useState(props.initialLocal);
  const [now, setNow] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ title: string; items: string[] } | null>(null);

  const at = now ? new Date() : brusselsFromLocal(local);
  const warnings = at ? sendWindowWarnings(at) : [];

  async function submit() {
    if (!at) return;
    setBusy(true);
    setError(null);
    const result = await scheduleCampaign({ campaignId: props.campaignId, expectedVersion: props.version, scheduledAt: now ? "now" : at, confirmOutsideWindow: confirm });
    setBusy(false);
    if (result.ok) {
      router.refresh();
      return;
    }
    if (result.error.code === "conflict") setError({ title: clab(labels, "errors.conflict"), items: [] });
    else if (result.error.fields)
      setError({ title: clab(labels, "errors.schedule_refused"), items: Object.entries(result.error.fields).map(([f, c]) => failureText(labels, f, String(c))) });
    else setError({ title: labels[`errors.${result.error.message}`] ?? clab(labels, "errors.generic"), items: [] });
  }

  return (
    <section className="grid max-w-xl gap-4" data-testid="schedule-panel">
      <h2 className="text-lg font-semibold">{clab(labels, "schedule_title")}</h2>
      <label className="flex items-center gap-2 text-sm">
        <Checkbox checked={now} onCheckedChange={(v) => setNow(v === true)} disabled={!props.canSchedule} data-testid="schedule-now" />
        {clab(labels, "send_now")}
      </label>
      {!now ? (
        <div className="grid gap-1">
          <Label htmlFor="campaign-scheduled-at">{clab(labels, "scheduled_at")}</Label>
          <Input id="campaign-scheduled-at" type="datetime-local" value={local} onChange={(e) => setLocal(e.target.value)} disabled={!props.canSchedule} />
        </div>
      ) : null}
      {warnings.length ? (
        <div className="grid gap-2 rounded-md border border-amber-500 p-3 text-sm" role="status">
          <p>{clab(labels, "outside_window", { reasons: warnings.map((w) => clab(labels, `outside_${w}`)).join(", ") })}</p>
          <label className="flex items-center gap-2">
            <Checkbox checked={confirm} onCheckedChange={(v) => setConfirm(v === true)} disabled={!props.canSchedule} data-testid="schedule-confirm-outside" />
            {clab(labels, "confirm_outside")}
          </label>
        </div>
      ) : null}
      {error ? (
        <Alert variant="destructive" data-testid="schedule-error">
          <AlertTitle>{error.title}</AlertTitle>
          {error.items.length ? (
            <AlertDescription>
              <ul className="list-disc pl-5">
                {error.items.map((i) => (
                  <li key={i}>{i}</li>
                ))}
              </ul>
            </AlertDescription>
          ) : null}
        </Alert>
      ) : null}
      {props.canSchedule ? (
        <div>
          <Button onClick={() => void submit()} disabled={busy || !at || (warnings.length > 0 && !confirm)} data-testid="schedule-submit">
            {now ? clab(labels, "send_now") : clab(labels, "schedule")}
          </Button>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">{clab(labels, "errors.forbidden")}</p>
      )}
    </section>
  );
}
