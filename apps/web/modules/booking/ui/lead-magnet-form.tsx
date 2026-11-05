"use client";
/**
 * The Lead Magnet tab of `/admin/sessions/[id]` (booking spec 5.1, 3.4, R20-R27; booking-P7):
 * Lead Magnet on or off, the places reserved for leads as a number or as a percentage of the
 * capacity (rounded down by the action), the lead window as Europe/Brussels wall-clock times,
 * the release rule, the optional public opening, the claim window and the visible queue
 * position. Submits `configureLeadMagnet` (`bookings.override`); the page hides the form when the
 * flag `ff_booking_lead_priority` is off for the staff user. Texts come from the page.
 */
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Alert, AlertDescription, Button, FormField, Input } from "@beam/ui";
import { configureLeadMagnet } from "../actions/lead";

const RULES = ["customers_then_public", "public", "keep_for_leads"] as const;
type Rule = (typeof RULES)[number];

export type LeadMagnetFormValues = {
  sessionId: string;
  capacity: number;
  isLeadMagnet: boolean;
  leadReservedSeats: number;
  /** Brussels wall clock `YYYY-MM-DDTHH:mm`, or "". */
  leadWindowStartLocal: string;
  leadWindowEndLocal: string;
  releaseRule: Rule;
  publicReleaseLocal: string;
  claimWindowMinutes: number;
  isWaitlistPositionVisible: boolean;
};

export type LeadMagnetFormLabels = {
  isLeadMagnet: string;
  seatsMode: string;
  seatsNumber: string;
  seatsPct: string;
  seats: string;
  pct: string;
  windowStart: string;
  windowEnd: string;
  releaseRule: string;
  rules: Record<Rule, string>;
  publicRelease: string;
  publicReleaseHint: string;
  claimWindow: string;
  positionVisible: string;
  save: string;
  saving: string;
  saved: string;
  errorWindow: string;
  errorSeats: string;
  errorPublicRelease: string;
  errors: Record<string, string>;
};

const selectClass =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

/** The message for a refused save: field-specific validation texts first, then the error map. */
function messageFor(error: { code: string; message: string; fields?: Record<string, string> }, labels: LeadMagnetFormLabels): string {
  if (error.code === "validation") {
    const fields = Object.keys(error.fields ?? {});
    if (error.message.includes("public_release") || fields.includes("publicReleaseLocal")) return labels.errorPublicRelease;
    if (error.message.includes("seats") || fields.some((f) => f.startsWith("leadReserved"))) return labels.errorSeats;
    if (error.message.includes("window") || fields.some((f) => f.startsWith("leadWindow"))) return labels.errorWindow;
  }
  const key = error.code === "conflict" ? error.message : error.code;
  return labels.errors[key] ?? labels.errors.validation ?? key;
}

export function LeadMagnetForm({ initial, labels }: { initial: LeadMagnetFormValues; labels: LeadMagnetFormLabels }) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(initial.isLeadMagnet);
  const [mode, setMode] = useState<"number" | "pct">("number");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const f = new FormData(event.currentTarget);
    const text = (k: string) => {
      const v = f.get(k);
      return typeof v === "string" ? v.trim() : "";
    };
    setPending(true);
    setMessage(null);
    try {
      const res = await configureLeadMagnet({
        sessionId: initial.sessionId,
        isLeadMagnet: enabled,
        ...(enabled
          ? {
              ...(mode === "number" ? { leadReservedSeats: Number(text("leadReservedSeats")) } : { leadReservedPct: Number(text("leadReservedPct")) }),
              leadWindowStartLocal: text("leadWindowStartLocal"),
              leadWindowEndLocal: text("leadWindowEndLocal"),
              publicReleaseLocal: text("publicReleaseLocal") || null,
            }
          : {}),
        releaseRule: text("releaseRule") as Rule,
        claimWindowMinutes: Number(text("claimWindowMinutes")),
        isWaitlistPositionVisible: f.get("isWaitlistPositionVisible") === "on",
      });
      if (res.ok) {
        setMessage({ error: false, text: labels.saved });
        router.refresh();
      } else {
        setMessage({ error: true, text: messageFor(res.error, labels) });
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={(e) => void onSubmit(e)} className="grid gap-4" noValidate data-testid="lead-magnet-form">
      {message ? (
        <Alert variant={message.error ? "destructive" : "default"} role={message.error ? "alert" : "status"} data-testid="lead-magnet-message">
          <AlertDescription>{message.text}</AlertDescription>
        </Alert>
      ) : null}
      <label className="flex min-h-11 items-center gap-3">
        <input type="checkbox" name="isLeadMagnet" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="size-5" data-testid="lead-enabled" />
        <span className="font-medium">{labels.isLeadMagnet}</span>
      </label>
      {enabled ? (
        <>
          <fieldset className="grid gap-2">
            <legend className="text-sm font-medium">{labels.seatsMode}</legend>
            <label className="flex items-center gap-2 text-sm">
              <input type="radio" name="seatsMode" checked={mode === "number"} onChange={() => setMode("number")} className="size-4" />
              {labels.seatsNumber}
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="radio" name="seatsMode" checked={mode === "pct"} onChange={() => setMode("pct")} className="size-4" data-testid="lead-mode-pct" />
              {labels.seatsPct}
            </label>
            {mode === "number" ? (
              <FormField label={labels.seats} required>
                <Input name="leadReservedSeats" type="number" min={0} max={initial.capacity} defaultValue={initial.leadReservedSeats} required data-testid="lead-seats" />
              </FormField>
            ) : (
              <FormField label={labels.pct} required>
                <Input name="leadReservedPct" type="number" min={0} max={100} step="any" defaultValue={0} required data-testid="lead-pct" />
              </FormField>
            )}
          </fieldset>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label={labels.windowStart} required>
              <Input name="leadWindowStartLocal" type="datetime-local" defaultValue={initial.leadWindowStartLocal} required data-testid="lead-window-start" />
            </FormField>
            <FormField label={labels.windowEnd} required>
              <Input name="leadWindowEndLocal" type="datetime-local" defaultValue={initial.leadWindowEndLocal} required data-testid="lead-window-end" />
            </FormField>
            <FormField label={labels.publicRelease} hint={labels.publicReleaseHint}>
              <Input name="publicReleaseLocal" type="datetime-local" defaultValue={initial.publicReleaseLocal} data-testid="lead-public-release" />
            </FormField>
          </div>
        </>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label={labels.releaseRule}>
          <select name="releaseRule" defaultValue={initial.releaseRule} className={selectClass} data-testid="lead-release-rule">
            {RULES.map((r) => (
              <option key={r} value={r}>
                {labels.rules[r]}
              </option>
            ))}
          </select>
        </FormField>
        <FormField label={labels.claimWindow} required>
          <Input name="claimWindowMinutes" type="number" min={10} max={2880} defaultValue={initial.claimWindowMinutes} required />
        </FormField>
      </div>
      <label className="flex min-h-11 items-center gap-3">
        <input type="checkbox" name="isWaitlistPositionVisible" defaultChecked={initial.isWaitlistPositionVisible} className="size-5" />
        <span>{labels.positionVisible}</span>
      </label>
      <div>
        <Button type="submit" disabled={pending} data-testid="lead-save">
          {pending ? labels.saving : labels.save}
        </Button>
      </div>
    </form>
  );
}
