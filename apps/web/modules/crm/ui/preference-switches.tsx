"use client";
/**
 * The marketing switches of the portal preferences page and the public preference centre (crm
 * spec 5.2, 5.3). WCAG 2.1 AA: every switch is a labelled `<button role="switch">` with
 * `aria-checked` and a visible focus ring; status messages are announced politely. Saves through
 * `updateMyPreferences` (portal) or `updatePreferencesByToken` (token). Every string is a prop.
 */
import { useId, useState } from "react";
import type { MarketingPurpose } from "@beam/core/crm";
import { Alert, AlertDescription, Button } from "@beam/ui";
import { updatePreferencesByToken } from "../consent/actions";
import { updateMyPreferences } from "../portal/actions";

export type PreferenceItem = { purpose: MarketingPurpose; label: string; wording: string | null };

export type PreferenceSwitchesLabels = {
  on: string;
  off: string;
  save: string;
  saving: string;
  saved: string;
  error: string;
  expired: string;
  unsubscribeAll: string;
  unsubscribedAll: string;
  minor: string;
  confirmSent: string;
  suppressed: string;
  alwaysArrive: string;
  language?: string;
};

export type PreferenceSwitchesProps = {
  mode: { kind: "portal" } | { kind: "token"; token: string };
  items: PreferenceItem[];
  initial: Record<MarketingPurpose, boolean>;
  /** The address is suppressed for good (bounce, complaint, everything): switches are disabled. */
  suppressedAll: boolean;
  /** Token links older than 365 days: only unsubscribing is offered. */
  canEdit?: boolean;
  languages?: { value: string; label: string }[];
  currentLocale?: string;
  labels: PreferenceSwitchesLabels;
};

type Status = { kind: "idle" | "saving" | "saved" | "error" | "expired" | "unsubscribed"; notes?: string[] };

export function PreferenceSwitches({ mode, items, initial, suppressedAll, canEdit = true, languages, currentLocale, labels }: PreferenceSwitchesProps) {
  const [values, setValues] = useState<Record<MarketingPurpose, boolean>>(initial);
  const [locale, setLocale] = useState(currentLocale ?? "");
  const [status, setStatus] = useState<Status>({ kind: suppressedAll ? "unsubscribed" : "idle" });
  const baseId = useId();
  const disabled = suppressedAll || status.kind === "saving" || status.kind === "unsubscribed";

  async function save(unsubscribeAll: boolean) {
    setStatus({ kind: "saving" });
    const purposes = unsubscribeAll ? { newsletter: false, events: false, member_comms: false, b2b: false } : values;
    const result =
      mode.kind === "portal"
        ? await updateMyPreferences({ ...purposes, unsubscribeAll })
        : await updatePreferencesByToken({ token: mode.token, purposes, unsubscribeAll, ...(locale && locale !== currentLocale ? { locale } : {}) });
    if (!result.ok) {
      setStatus({ kind: result.error.message === "link_expired" ? "expired" : "error" });
      return;
    }
    if (unsubscribeAll) {
      setValues(purposes);
      setStatus({ kind: "unsubscribed" });
      return;
    }
    const skipped = Object.entries(result.data.skipped ?? {}) as [MarketingPurpose, string][];
    const notes = skipped.map(([p, outcome]) => `${items.find((i) => i.purpose === p)?.label ?? p}: ${outcome === "skipped_minor" ? labels.minor : outcome === "needs_confirmation" ? labels.confirmSent : labels.suppressed}`);
    if (skipped.length) setValues((v) => ({ ...v, ...Object.fromEntries(skipped.map(([p]) => [p, false])) }));
    setStatus({ kind: "saved", notes });
  }

  return (
    <div className="grid gap-6">
      {suppressedAll ? (
        <Alert>
          <AlertDescription>{labels.suppressed}</AlertDescription>
        </Alert>
      ) : null}
      <ul className="grid gap-4">
        {items.map((item) => {
          const id = `${baseId}-${item.purpose}`;
          const checked = values[item.purpose];
          const locked = disabled || (!canEdit && !checked);
          return (
            <li key={item.purpose} className="flex items-start justify-between gap-4 rounded-md border border-border p-4">
              <div className="grid gap-1">
                <span id={`${id}-label`} className="font-medium text-foreground">
                  {item.label}
                </span>
                {item.wording ? (
                  <span id={`${id}-desc`} className="text-sm text-foreground/80">
                    {item.wording}
                  </span>
                ) : null}
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={checked}
                aria-labelledby={`${id}-label`}
                aria-describedby={item.wording ? `${id}-desc` : undefined}
                disabled={locked}
                onClick={() => setValues((v) => ({ ...v, [item.purpose]: !v[item.purpose] }))}
                className={`inline-flex h-7 min-w-14 shrink-0 items-center justify-center rounded-full border-2 px-2 text-xs font-semibold outline-none focus-visible:ring-4 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60 ${
                  checked ? "border-primary bg-primary text-primary-foreground" : "border-foreground/60 bg-background text-foreground"
                }`}
              >
                {checked ? labels.on : labels.off}
              </button>
            </li>
          );
        })}
      </ul>
      {languages && labels.language ? (
        <label className="grid max-w-xs gap-1 text-sm font-medium">
          {labels.language}
          <select
            className="h-9 rounded-md border border-input bg-background px-3 text-sm focus-visible:ring-4 focus-visible:ring-ring"
            value={locale}
            disabled={disabled || !canEdit}
            onChange={(e) => setLocale(e.target.value)}
          >
            {languages.map((l) => (
              <option key={l.value} value={l.value}>
                {l.label}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <p className="text-sm text-foreground/80">{labels.alwaysArrive}</p>
      <div className="flex flex-wrap gap-3">
        <Button type="button" onClick={() => void save(false)} disabled={disabled}>
          {status.kind === "saving" ? labels.saving : labels.save}
        </Button>
        <Button type="button" variant="outline" onClick={() => void save(true)} disabled={disabled}>
          {labels.unsubscribeAll}
        </Button>
      </div>
      <div aria-live="polite" role="status" className="text-sm">
        {status.kind === "saved" ? (
          <div className="grid gap-1">
            <p>{labels.saved}</p>
            {status.notes?.map((n) => (
              <p key={n}>{n}</p>
            ))}
          </div>
        ) : null}
        {status.kind === "unsubscribed" && !suppressedAll ? <p>{labels.unsubscribedAll}</p> : null}
        {status.kind === "error" ? <p className="text-destructive">{labels.error}</p> : null}
        {status.kind === "expired" ? <p className="text-destructive">{labels.expired}</p> : null}
      </div>
    </div>
  );
}
