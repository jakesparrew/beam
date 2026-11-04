"use client";
/**
 * The generic settings editor (PL-41) and the small client helpers every platform-admin form
 * shares: `useRun()` runs a Server Action and maps its error code to a catalogue message,
 * `Feedback` shows the result with `role="status"` or `role="alert"`. Strings arrive as props
 * (catalogue sections resolved on the server); `fill()` fills ICU parameters.
 */
import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent, type ReactNode } from "react";
import { Alert, AlertDescription, Button, FormField, Input, LocalizedInput, Switch, Textarea } from "@beam/ui";
import { LOCALES } from "@beam/core/i18n";
import type { ActionResult } from "@/lib/action";
import { setAiSensitiveProcessing, updateSetting } from "../actions";
import { fill } from "./login-form";
import { getAt, setAt, type FormFieldSpec } from "./zod-form";

export type Labels = Readonly<Record<string, string>>;

/** A label by name, or the name itself when the section lacks it. */
export const lab = (labels: Labels, key: string, params?: Record<string, string | number>) => fill(labels[key] ?? key, params);

export type RunState = { pending: boolean; ok: string | null; error: string | null };

/** Runs an action; on success shows `okText` and refreshes the route, on failure maps the code to `errors`. */
export function useRun(errors: Labels) {
  const router = useRouter();
  const [state, setState] = useState<RunState>({ pending: false, ok: null, error: null });
  const [, startTransition] = useTransition();
  async function run<O>(call: () => Promise<ActionResult<O>>, okText: string | null, onOk?: (data: O) => void): Promise<boolean> {
    setState({ pending: true, ok: null, error: null });
    const result = await call();
    if (result.ok) {
      setState({ pending: false, ok: okText, error: null });
      onOk?.(result.data);
      startTransition(() => router.refresh());
      return true;
    }
    const { code, message, fields } = result.error;
    const specific = errors[`${code}_${message.split(":")[0]}`];
    const fieldText = fields ? Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join("; ") : "";
    const base = specific ?? fill(errors[code] ?? errors.internal ?? code, { requestId: "" });
    setState({ pending: false, ok: null, error: code === "validation" && fieldText ? `${base} (${fieldText})` : base });
    return false;
  }
  return { ...state, run, reset: () => setState({ pending: false, ok: null, error: null }) };
}

export function Feedback({ ok, error }: { ok: string | null; error: string | null }) {
  if (error) {
    return (
      <Alert variant="destructive" role="alert">
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    );
  }
  if (ok) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        {ok}
      </p>
    );
  }
  return null;
}

/** The text of a scalar value for an input (objects never reach scalar fields). */
const scalarText = (v: unknown): string => (typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? String(v) : "");

/** A field label from the section (`field_<a_b>`) or the dotted path. */
function fieldLabel(labels: Labels, f: FormFieldSpec): string {
  return labels[`field_${f.path.join("_")}`] ?? f.name.replace(/_/g, " ");
}

function FieldInput({ field, value, onChange, labels }: { field: FormFieldSpec; value: unknown; onChange: (v: unknown) => void; labels: Labels }): ReactNode {
  const label = fieldLabel(labels, field);
  const id = `setting-${field.name}`;
  switch (field.kind) {
    case "boolean":
      return (
        <div className="flex items-center gap-3">
          <Switch id={id} checked={value === true} onCheckedChange={(v) => onChange(v)} aria-label={label} />
          <label htmlFor={id} className="text-sm">
            {label}
          </label>
        </div>
      );
    case "localized":
      return (
        <LocalizedInput
          name={field.name}
          value={(value as Record<string, string>) ?? {}}
          onChange={(v) => onChange(v)}
          locales={LOCALES}
          labels={{ field: label, locales: { "nl-BE": "Nederlands", "fr-BE": "Français", en: "English" }, missing: lab(labels, "locale_missing"), complete: lab(labels, "locale_complete") }}
        />
      );
    case "enum":
    case "literal":
      return (
        <FormField label={label} id={id}>
          <select className="h-9 rounded-md border bg-background px-2 text-sm" value={scalarText(value)} onChange={(e) => onChange(e.target.value === "" && field.nullable ? null : e.target.value)}>
            {field.nullable || field.optional ? <option value="">{lab(labels, "none")}</option> : null}
            {(field.options ?? []).map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        </FormField>
      );
    case "number":
    case "integer":
      return (
        <FormField label={label} id={id}>
          <Input
            type="number"
            step={field.kind === "integer" ? 1 : "any"}
            value={scalarText(value)}
            onChange={(e) => onChange(e.target.value === "" ? (field.nullable ? null : undefined) : Number(e.target.value))}
          />
        </FormField>
      );
    case "string_list":
    case "number_list":
      return (
        <FormField label={label} id={id} hint={lab(labels, "one_per_line")}>
          <Textarea
            rows={3}
            value={Array.isArray(value) ? value.join("\n") : ""}
            onChange={(e) => {
              const lines = e.target.value.split("\n").map((l) => l.trim()).filter(Boolean);
              onChange(field.kind === "number_list" ? lines.map(Number) : lines);
            }}
          />
        </FormField>
      );
    case "json":
      return <JsonField id={id} label={label} value={value} onChange={onChange} labels={labels} />;
    default:
      return (
        <FormField label={label} id={id}>
          <Input value={scalarText(value)} onChange={(e) => onChange(e.target.value === "" && field.nullable ? null : e.target.value)} />
        </FormField>
      );
  }
}

function JsonField({ id, label, value, onChange, labels }: { id: string; label: string; value: unknown; onChange: (v: unknown) => void; labels: Labels }) {
  const [text, setText] = useState(() => JSON.stringify(value ?? null, null, 2));
  const [invalid, setInvalid] = useState(false);
  return (
    <FormField label={label} id={id} error={invalid ? lab(labels, "invalid_json") : null}>
      <Textarea
        rows={Math.min(14, Math.max(3, text.split("\n").length))}
        className="font-mono text-xs"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          try {
            onChange(JSON.parse(e.target.value));
            setInvalid(false);
          } catch {
            setInvalid(true);
          }
        }}
      />
    </FormField>
  );
}

/** The editor of one settings key: a form from `zodToFormFields`, submitted with `expectedVersion` (PL-41). */
export function SettingsForm({ settingKey, version, value, fields, labels, errors, readOnly }: { settingKey: string; version: number; value: unknown; fields: FormFieldSpec[]; labels: Labels; errors: Labels; readOnly?: boolean }) {
  const [draft, setDraft] = useState<unknown>(value);
  const r = useRun(errors);
  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    await r.run(() => updateSetting({ key: settingKey, value: draft, expectedVersion: version }), lab(labels, "saved"));
  }
  return (
    <form onSubmit={(e) => void onSubmit(e)} className="grid max-w-2xl gap-4" noValidate>
      <fieldset disabled={readOnly || r.pending} className="grid gap-4">
        {fields.map((f) => (
          <div key={f.name} className="grid gap-1">
            <FieldInput field={f} value={getAt(draft, f.path)} onChange={(v) => setDraft((d: unknown) => setAt(d, f.path, v))} labels={labels} />
            {f.description ? <p className="text-xs text-muted-foreground">{f.description}</p> : null}
          </div>
        ))}
      </fieldset>
      <Feedback ok={r.ok} error={r.error} />
      {readOnly ? null : (
        <div>
          <Button type="submit" disabled={r.pending}>
            {r.pending ? lab(labels, "saving") : lab(labels, "save")}
          </Button>
        </div>
      )}
    </form>
  );
}

/**
 * The sensitive-processing panel of `/admin/settings/ai` (PL-55): switching on needs the owner,
 * a purpose of at least 20 characters and a DPIA reference (the server also checks ops' DPIA
 * register); owner or technical_admin may switch it off.
 */
export function AiSensitivePanel({
  enabled,
  purpose,
  dpiaReference,
  enabledBy,
  enabledAt,
  canEnable,
  canDisable,
  labels,
  errors,
}: {
  enabled: boolean;
  purpose: string | null;
  dpiaReference: string | null;
  enabledBy: string | null;
  enabledAt: string | null;
  canEnable: boolean;
  canDisable: boolean;
  labels: Labels;
  errors: Labels;
}) {
  const [draftPurpose, setPurpose] = useState(purpose ?? "");
  const [draftDpia, setDpia] = useState(dpiaReference ?? "");
  const r = useRun(errors);
  return (
    <section className="grid max-w-2xl gap-3 rounded-md border p-4" aria-labelledby="ai-sensitive-title">
      <h2 id="ai-sensitive-title" className="text-lg font-medium">
        {lab(labels, "sensitive_title")}
      </h2>
      <p className="text-sm text-muted-foreground">{lab(labels, "sensitive_intro")}</p>
      <p className="text-sm">
        <strong>{lab(labels, enabled ? "sensitive_on" : "sensitive_off")}</strong>
        {enabled && enabledAt ? ` · ${lab(labels, "sensitive_enabled_by", { who: enabledBy ?? "–", when: new Date(enabledAt).toLocaleString() })}` : ""}
      </p>
      {enabled ? (
        <>
          <p className="text-sm">
            {lab(labels, "purpose")}: {purpose ?? "–"}
          </p>
          <p className="text-sm">
            {lab(labels, "dpia_reference")}: {dpiaReference ?? "–"}
          </p>
          {canDisable ? (
            <div>
              <Button type="button" variant="destructive" disabled={r.pending} onClick={() => void r.run(() => setAiSensitiveProcessing({ enabled: false }), lab(labels, "sensitive_disabled_done"))}>
                {lab(labels, "sensitive_disable")}
              </Button>
            </div>
          ) : null}
        </>
      ) : canEnable ? (
        <>
          <FormField label={lab(labels, "purpose")} hint={lab(labels, "purpose_hint")}>
            <Textarea value={draftPurpose} onChange={(e) => setPurpose(e.target.value)} rows={3} />
          </FormField>
          <FormField label={lab(labels, "dpia_reference")}>
            <Input value={draftDpia} onChange={(e) => setDpia(e.target.value)} />
          </FormField>
          <div>
            <Button
              type="button"
              disabled={r.pending || draftPurpose.trim().length < 20 || draftDpia.trim().length < 3}
              onClick={() => void r.run(() => setAiSensitiveProcessing({ enabled: true, purpose: draftPurpose.trim(), dpiaReference: draftDpia.trim() }), lab(labels, "sensitive_enabled_done"))}
            >
              {lab(labels, "sensitive_enable")}
            </Button>
          </div>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">{lab(labels, "sensitive_owner_only")}</p>
      )}
      <Feedback ok={r.ok} error={r.error} />
    </section>
  );
}
