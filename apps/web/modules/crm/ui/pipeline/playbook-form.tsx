"use client";
/**
 * Edit one sales playbook stage (crm spec 5.1, `/admin/pipeline/playbook`; `settings.write`):
 * name, required action, owner role, deadline, default probability (B2B only), automated and
 * human communication, escalation, KPI, order and active state. The texts need all three
 * languages (`assertComplete`, the server answers `missing_locales`).
 */
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Alert, AlertDescription, Button, FormField, Input, LocalizedInput, type LocalizedInputLabels, type LocalizedValue } from "@beam/ui";
import type { RoleKey } from "@beam/db/schema";
import { savePlaybookStage } from "../../pipeline/actions";

type Locale = "nl-BE" | "fr-BE" | "en";
const LOCALES: readonly Locale[] = ["nl-BE", "fr-BE", "en"];

export type PlaybookStageValues = {
  pipeline: "b2b" | "b2c";
  stageKey: string;
  sortOrder: number;
  name: LocalizedValue<Locale>;
  requiredAction: LocalizedValue<Locale>;
  ownerRole: string;
  deadlineDays: number;
  defaultProbabilityPct: number | null;
  automationSlug: string;
  templateSlug: string;
  humanCommunication: LocalizedValue<Locale>;
  escalationAfterDays: number | null;
  escalationNotifyRole: string;
  escalationCreateTask: boolean;
  kpiName: LocalizedValue<Locale>;
  kpiTarget: number | null;
  kpiUnit: string;
  isActive: boolean;
};

export type PlaybookFormLabels = {
  name: string;
  requiredAction: string;
  ownerRole: string;
  deadlineDays: string;
  defaultProbability: string;
  automationSlug: string;
  templateSlug: string;
  humanCommunication: string;
  escalationAfterDays: string;
  escalationNotifyRole: string;
  escalationCreateTask: string;
  kpiName: string;
  kpiTarget: string;
  kpiUnit: string;
  sortOrder: string;
  isActive: string;
  none: string;
  save: string;
  saving: string;
  saved: string;
  error: string;
  missingLocales: string;
  localized: Omit<LocalizedInputLabels<Locale>, "field">;
  roles: Record<string, string>;
  units: Record<string, string>;
};

const selectClass =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

const filled = (v: LocalizedValue<Locale>) => LOCALES.some((l) => !!v[l]?.trim());
const num = (raw: FormDataEntryValue | null): number | undefined => {
  const s = String(raw ?? "").trim();
  if (!s) return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n) : undefined;
};

export function PlaybookForm({ initial, labels, roles, canEdit }: { initial: PlaybookStageValues; labels: PlaybookFormLabels; roles: readonly string[]; canEdit: boolean }) {
  const router = useRouter();
  const [name, setName] = useState(initial.name);
  const [requiredAction, setRequiredAction] = useState(initial.requiredAction);
  const [human, setHuman] = useState(initial.humanCommunication);
  const [kpiName, setKpiName] = useState(initial.kpiName);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const loc = (field: string): LocalizedInputLabels<Locale> => ({ ...labels.localized, field });

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const get = (k: string) => String(form.get(k) ?? "").trim();
    const after = num(form.get("escalationAfterDays"));
    const target = num(form.get("kpiTarget"));
    const probability = num(form.get("defaultProbabilityPct"));
    const notifyRole = get("escalationNotifyRole");
    const unit = get("kpiUnit");
    setPending(true);
    setMessage(null);
    try {
      const result = await savePlaybookStage({
        pipeline: initial.pipeline,
        stageKey: initial.stageKey,
        sortOrder: num(form.get("sortOrder")) ?? initial.sortOrder,
        name,
        requiredAction,
        ownerRole: get("ownerRole") as RoleKey,
        deadlineDays: num(form.get("deadlineDays")) ?? initial.deadlineDays,
        ...(initial.pipeline === "b2b" ? { defaultProbabilityPct: probability ?? null } : {}),
        automatedCommunication: { ...(get("automationSlug") ? { automation_slug: get("automationSlug") } : {}), ...(get("templateSlug") ? { template_slug: get("templateSlug") } : {}) },
        humanCommunication: filled(human) ? human : null,
        escalation: {
          ...(after !== undefined ? { after_days: after } : {}),
          ...(notifyRole ? { notify_role: notifyRole as RoleKey } : {}),
          create_task: form.get("escalationCreateTask") === "on",
        },
        kpi: { ...(filled(kpiName) ? { name: kpiName } : {}), ...(target !== undefined ? { target } : {}), ...(unit ? { unit: unit as "count" | "pct" | "cents" | "days" } : {}) },
        isActive: form.get("isActive") === "on",
      });
      if (result.ok) {
        setMessage({ ok: true, text: labels.saved });
        router.refresh();
        return;
      }
      setMessage({ ok: false, text: result.error.message === "missing_locales" ? labels.missingLocales : labels.error });
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={(e) => void onSubmit(e)} className="grid gap-4" noValidate>
      {message ? (
        <Alert variant={message.ok ? "default" : "destructive"} role={message.ok ? "status" : "alert"}>
          <AlertDescription>{message.text}</AlertDescription>
        </Alert>
      ) : null}
      <fieldset disabled={!canEdit || pending} className="grid gap-4">
        <LocalizedInput name="name" value={name} onChange={setName} locales={LOCALES} labels={loc(labels.name)} />
        <LocalizedInput name="requiredAction" value={requiredAction} onChange={setRequiredAction} locales={LOCALES} labels={loc(labels.requiredAction)} />
        <div className="grid gap-4 sm:grid-cols-4">
          <FormField label={labels.ownerRole} required>
            <select name="ownerRole" defaultValue={initial.ownerRole} className={selectClass}>
              {roles.map((r) => (
                <option key={r} value={r}>
                  {labels.roles[r] ?? r}
                </option>
              ))}
            </select>
          </FormField>
          <FormField label={labels.deadlineDays}>
            <Input name="deadlineDays" type="number" min={0} max={365} defaultValue={initial.deadlineDays} />
          </FormField>
          {initial.pipeline === "b2b" ? (
            <FormField label={labels.defaultProbability}>
              <Input name="defaultProbabilityPct" type="number" min={0} max={100} defaultValue={initial.defaultProbabilityPct ?? ""} />
            </FormField>
          ) : null}
          <FormField label={labels.sortOrder}>
            <Input name="sortOrder" type="number" min={0} max={32767} defaultValue={initial.sortOrder} />
          </FormField>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label={labels.automationSlug}>
            <Input name="automationSlug" defaultValue={initial.automationSlug} maxLength={100} />
          </FormField>
          <FormField label={labels.templateSlug}>
            <Input name="templateSlug" defaultValue={initial.templateSlug} maxLength={100} />
          </FormField>
        </div>
        <LocalizedInput name="humanCommunication" value={human} onChange={setHuman} locales={LOCALES} multiline labels={loc(labels.humanCommunication)} />
        <div className="grid gap-4 sm:grid-cols-3">
          <FormField label={labels.escalationAfterDays}>
            <Input name="escalationAfterDays" type="number" min={0} max={365} defaultValue={initial.escalationAfterDays ?? ""} />
          </FormField>
          <FormField label={labels.escalationNotifyRole}>
            <select name="escalationNotifyRole" defaultValue={initial.escalationNotifyRole} className={selectClass}>
              <option value="">{labels.none}</option>
              {roles.map((r) => (
                <option key={r} value={r}>
                  {labels.roles[r] ?? r}
                </option>
              ))}
            </select>
          </FormField>
          <label className="flex items-center gap-2 self-end pb-2 text-sm">
            <input type="checkbox" name="escalationCreateTask" defaultChecked={initial.escalationCreateTask} />
            {labels.escalationCreateTask}
          </label>
        </div>
        <LocalizedInput name="kpiName" value={kpiName} onChange={setKpiName} locales={LOCALES} labels={loc(labels.kpiName)} />
        <div className="grid gap-4 sm:grid-cols-3">
          <FormField label={labels.kpiTarget}>
            <Input name="kpiTarget" type="number" min={0} defaultValue={initial.kpiTarget ?? ""} />
          </FormField>
          <FormField label={labels.kpiUnit}>
            <select name="kpiUnit" defaultValue={initial.kpiUnit} className={selectClass}>
              <option value="">{labels.none}</option>
              {(["count", "pct", "cents", "days"] as const).map((u) => (
                <option key={u} value={u}>
                  {labels.units[u] ?? u}
                </option>
              ))}
            </select>
          </FormField>
          <label className="flex items-center gap-2 self-end pb-2 text-sm">
            <input type="checkbox" name="isActive" defaultChecked={initial.isActive} />
            {labels.isActive}
          </label>
        </div>
        {canEdit ? (
          <div>
            <Button type="submit" disabled={pending}>
              {pending ? labels.saving : labels.save}
            </Button>
          </div>
        ) : null}
      </fieldset>
    </form>
  );
}
