"use client";
/**
 * The form of `/admin/automations/rules` (automation spec 5, R2, automation-P7): frequency caps
 * (per 24 hours, per 7 days), quiet hours (Europe/Brussels) and the webhook host allow-list, one
 * host per line, posted as one `updateAutomationRules` call with the version the page read (a
 * stale version is shown as the catalogue's `errors.stale_version`). Without `settings.write`
 * the host list is read-only and is sent back unchanged, so the caps can still be saved.
 */
import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent } from "react";
import { Alert, AlertDescription, Button, FormField, Input, Textarea } from "@beam/ui";
import { updateAutomationRules } from "../actions";
import { errorText, fill, formStr, type ActionResultLike, type Labels } from "./outcome-badge";

export type RulesFormValue = {
  version: number;
  maxMarketingPerDay: number;
  maxMarketingPerWeek: number;
  quietStart: string;
  quietEnd: string;
  webhookHosts: string[];
};

export type RulesFormProps = { value: RulesFormValue; canEditHosts: boolean; labels: Labels };

/** The host lines of the textarea: trimmed, lower-cased, empty lines dropped. */
export function parseHostLines(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

/** The field a Zod path of the action input belongs to (`webhookHosts.1` -> `webhookHosts`). */
const fieldOf = (path: string) => path.split(".")[0] ?? path;

export function RulesForm({ value, canEditHosts, labels: l }: RulesFormProps) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [fields, setFields] = useState<Record<string, string>>({});
  const capsId = useId();
  const quietId = useId();
  const hostsId = useId();

  const fieldError = (name: string): string | null => {
    const code = Object.entries(fields).find(([path]) => fieldOf(path) === name)?.[1];
    return code ? (l[`errors.${code}`] ?? l["errors.validation"] ?? code) : null;
  };

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const input = {
      expectedVersion: value.version,
      maxMarketingPerDay: Number(formStr(form, "maxMarketingPerDay")),
      maxMarketingPerWeek: Number(formStr(form, "maxMarketingPerWeek")),
      quietStart: formStr(form, "quietStart"),
      quietEnd: formStr(form, "quietEnd"),
      webhookHosts: canEditHosts ? parseHostLines(formStr(form, "webhookHosts")) : value.webhookHosts,
    };
    setBusy(true);
    setError(null);
    setSaved(false);
    setFields({});
    try {
      const r = (await updateAutomationRules(input)) as ActionResultLike;
      if (!r.ok) {
        if (r.error.code === "validation" && r.error.fields && Object.keys(r.error.fields).length) setFields(r.error.fields);
        else setError(errorText(r.error, l));
        return;
      }
      setSaved(true);
      router.refresh();
    } catch {
      setError(l["errors.generic"] ?? "");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="grid max-w-2xl gap-8" data-testid="rules-form">
      <fieldset className="grid gap-4" aria-labelledby={capsId}>
        <div className="grid gap-1">
          <h2 id={capsId} className="text-lg font-semibold">
            {l["rules.caps_title"]}
          </h2>
          <p className="text-sm text-muted-foreground">{l["rules.caps_help"]}</p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label={l["rules.per_day"]} hint={l["rules.per_day_help"]} error={fieldError("maxMarketingPerDay")} required>
            <Input name="maxMarketingPerDay" type="number" min={0} max={10} step={1} defaultValue={value.maxMarketingPerDay} required />
          </FormField>
          <FormField label={l["rules.per_week"]} hint={l["rules.per_week_help"]} error={fieldError("maxMarketingPerWeek")} required>
            <Input name="maxMarketingPerWeek" type="number" min={0} max={30} step={1} defaultValue={value.maxMarketingPerWeek} required />
          </FormField>
        </div>
      </fieldset>

      <fieldset className="grid gap-4" aria-labelledby={quietId}>
        <div className="grid gap-1">
          <h2 id={quietId} className="text-lg font-semibold">
            {l["rules.quiet_title"]}
          </h2>
          <p className="text-sm text-muted-foreground">{l["rules.quiet_help"]}</p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label={l["rules.quiet_start"]} error={fieldError("quietStart")} required>
            <Input name="quietStart" type="time" step={60} defaultValue={value.quietStart} required />
          </FormField>
          <FormField label={l["rules.quiet_end"]} error={fieldError("quietEnd")} required>
            <Input name="quietEnd" type="time" step={60} defaultValue={value.quietEnd} required />
          </FormField>
        </div>
      </fieldset>

      <fieldset className="grid gap-4" aria-labelledby={hostsId}>
        <div className="grid gap-1">
          <h2 id={hostsId} className="text-lg font-semibold">
            {l["rules.hosts_title"]}
          </h2>
          <p className="text-sm text-muted-foreground">{l["rules.hosts_help"]}</p>
        </div>
        <FormField label={l["rules.hosts_label"]} hint={canEditHosts ? undefined : l["rules.hosts_readonly"]} error={fieldError("webhookHosts")}>
          <Textarea
            name="webhookHosts"
            defaultValue={value.webhookHosts.join("\n")}
            readOnly={!canEditHosts}
            rows={Math.max(3, Math.min(10, value.webhookHosts.length + 1))}
            placeholder={value.webhookHosts.length ? undefined : l["rules.hosts_empty"]}
            spellCheck={false}
            className="font-mono"
            data-testid="rules-hosts"
          />
        </FormField>
      </fieldset>

      {error ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {saved ? (
        <Alert role="status">
          <AlertDescription>{l["rules.saved"]}</AlertDescription>
        </Alert>
      ) : null}
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={busy} data-testid="rules-save">
          {busy ? l["common.saving"] : l["rules.save"]}
        </Button>
        <span className="text-xs text-muted-foreground">{fill(l["rules.version"], { version: value.version })}</span>
      </div>
    </form>
  );
}
