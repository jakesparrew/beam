"use client";
/**
 * Security incident form (`/admin/system/incidents`, blueprint 65; PL-73, PL-73a): the seven
 * fields (discovery time, systems affected, data affected, risk, actions, notifications,
 * resolution), severity and status. Status offers only the allowed transitions; reopening a
 * resolved incident needs a note; "BEAM notified" is set once and never cleared. Free text must
 * not name customers (hint under the form).
 */
import { useRouter } from "next/navigation";
import { type FormEvent } from "react";
import { Button, FormField, Input, Textarea } from "@beam/ui";
import { createIncident, updateIncident } from "../actions";
import { formValue } from "./login-form";
import { Feedback, lab, useRun, type Labels } from "./settings-form";

export type IncidentView = {
  id: string;
  title: string;
  severity: "critical" | "high" | "normal";
  status: "open" | "contained" | "resolved";
  discoveredAt: string;
  beamNotifiedAt: string | null;
  systemsAffected: string;
  dataAffected: string;
  risk: string;
  actions: string;
  notifications: string;
  resolution: string;
};

const NEXT: Record<IncidentView["status"], IncidentView["status"][]> = { open: ["contained", "resolved"], contained: ["resolved"], resolved: ["open"] };
const TEXT_FIELDS = ["systemsAffected", "dataAffected", "risk", "actions", "notifications", "resolution"] as const;

/** `datetime-local` value in the browser's zone (staff work in Brussels). */
function localInput(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function IncidentForm({ incident, labels, errors }: { incident?: IncidentView; labels: Labels; errors: Labels }) {
  const r = useRun(errors);
  const router = useRouter();
  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const discovered = formValue(form, "discoveredAt");
    const notified = formValue(form, "beamNotifiedAt");
    const text = Object.fromEntries(TEXT_FIELDS.map((f) => [f, formValue(form, f)]));
    const common = {
      title: formValue(form, "title"),
      severity: formValue(form, "severity"),
      discoveredAt: discovered ? new Date(discovered).toISOString() : new Date().toISOString(),
      ...(notified ? { beamNotifiedAt: new Date(notified).toISOString() } : {}),
      ...text,
    };
    if (!incident) {
      await r.run(() => createIncident(common), lab(labels, "created"), (data) => router.push(`/admin/system/incidents/${data.incidentId}` as never));
      return;
    }
    const status = formValue(form, "status");
    const note = formValue(form, "note").trim();
    await r.run(() => updateIncident({ id: incident.id, ...common, ...(status ? { status } : {}), ...(note ? { note } : {}) }), lab(labels, "saved"));
  }
  return (
    <form onSubmit={(e) => void onSubmit(e)} className="grid max-w-3xl gap-3" noValidate>
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField label={lab(labels, "field_title")}>
          <Input name="title" defaultValue={incident?.title ?? ""} required minLength={3} maxLength={200} />
        </FormField>
        <FormField label={lab(labels, "field_severity")}>
          <select name="severity" defaultValue={incident?.severity ?? "normal"} className="h-9 rounded-md border bg-background px-2 text-sm">
            {(["critical", "high", "normal"] as const).map((s) => (
              <option key={s} value={s}>
                {lab(labels, `severity_${s}`)}
              </option>
            ))}
          </select>
        </FormField>
        <FormField label={lab(labels, "field_discovered_at")}>
          <Input name="discoveredAt" type="datetime-local" defaultValue={localInput(incident?.discoveredAt)} required />
        </FormField>
        <FormField label={lab(labels, "field_beam_notified_at")} hint={incident?.beamNotifiedAt ? lab(labels, "notified_fixed") : lab(labels, "notified_hint")}>
          <Input name="beamNotifiedAt" type="datetime-local" defaultValue={localInput(incident?.beamNotifiedAt)} readOnly={!!incident?.beamNotifiedAt} />
        </FormField>
        {incident ? (
          <FormField label={lab(labels, "field_status")}>
            <select name="status" defaultValue="" className="h-9 rounded-md border bg-background px-2 text-sm">
              <option value="">{lab(labels, `status_${incident.status}`)}</option>
              {NEXT[incident.status].map((s) => (
                <option key={s} value={s}>
                  {lab(labels, "move_to", { status: lab(labels, `status_${s}`) })}
                </option>
              ))}
            </select>
          </FormField>
        ) : null}
      </div>
      {TEXT_FIELDS.map((f) => (
        <FormField key={f} label={lab(labels, `field_${f}`)}>
          <Textarea name={f} rows={f === "actions" ? 5 : 3} defaultValue={incident?.[f] ?? ""} />
        </FormField>
      ))}
      {incident ? (
        <FormField label={lab(labels, "field_note")} hint={lab(labels, "note_hint")}>
          <Textarea name="note" rows={2} />
        </FormField>
      ) : null}
      <p className="text-xs text-muted-foreground">{lab(labels, "no_customer_names")}</p>
      <Feedback ok={r.ok} error={r.error} />
      <div>
        <Button type="submit" disabled={r.pending}>
          {incident ? lab(labels, "save") : lab(labels, "create")}
        </Button>
      </div>
    </form>
  );
}
