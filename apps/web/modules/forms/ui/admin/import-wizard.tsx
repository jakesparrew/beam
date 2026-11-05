"use client";

/**
 * The import source wizard (forms spec section 5 `/admin/forms/imports`; forms-P7, rules I1 and
 * I2): provider and name, the person paths (email, names, language, result id, completion date),
 * the mirror fields with their paths and the sensitive flag, the result (score, outcome and the
 * external values that map to mirror outcomes) and the consents that are recorded only from a
 * literal `true`. `createImportSource` publishes the mirror form; the webhook URL with its secret
 * is shown once. `ImportSourceToggle` (de)activates a source from the list.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Checkbox, Input, toast } from "@beam/ui";
import { FORM_CONSENT_PURPOSES, type Field, type FormConsentPurpose, type ImportMapping } from "@beam/core/forms";
import { createImportSource, updateImportSource } from "../../actions";
import { selectClass } from "./condition-builder";
import { lbl, type Labels } from "./issues-panel";

type Provider = "scoreapp" | "typeform";
const FIELD_TYPES = ["short_text", "long_text", "number", "yes_no", "date"] as const;
type MirrorType = (typeof FIELD_TYPES)[number];
type FieldRow = { key: string; label: string; type: MirrorType; path: string; sensitive: boolean };
type OutcomeRow = { key: string; label: string; external: string };
type PersonPaths = { email: string; firstName: string; lastName: string; phone: string; locale: string; externalId: string; completedAt: string; score: string; outcome: string };

const PRESETS: Record<Provider, { person: PersonPaths; fields: FieldRow[]; consents: Partial<Record<FormConsentPurpose, string>> }> = {
  typeform: {
    person: {
      email: "form_response.hidden.email",
      firstName: "form_response.answers[field.ref=first_name].text",
      lastName: "",
      phone: "",
      locale: "form_response.hidden.lang",
      externalId: "event_id",
      completedAt: "form_response.submitted_at",
      score: "form_response.calculated.score",
      outcome: "form_response.variables[key=outcome].text",
    },
    fields: [{ key: "sleep", label: "Sleep", type: "number", path: "form_response.answers[field.ref=sleep].number", sensitive: true }],
    consents: { newsletter: "form_response.answers[field.ref=newsletter].boolean" },
  },
  scoreapp: {
    person: {
      email: "lead.email",
      firstName: "lead.first_name",
      lastName: "lead.last_name",
      phone: "lead.phone",
      locale: "lead.language",
      externalId: "id",
      completedAt: "created_at",
      score: "score.percentage",
      outcome: "score.tier",
    },
    fields: [{ key: "sleep_hours", label: "Sleep hours", type: "short_text", path: "answers.sleep_hours", sensitive: true }],
    consents: { newsletter: "consents.marketing" },
  },
};

const LOCALES = ["nl-BE", "fr-BE", "en"] as const;
const all = (s: string) => Object.fromEntries(LOCALES.map((l) => [l, s])) as Record<(typeof LOCALES)[number], string>;

function mirrorField(f: FieldRow): Field {
  const base = { key: f.key, label: all(f.label || f.key), required: false, sensitive: f.sensitive };
  return { ...base, type: f.type } as Field;
}

export type ImportWizardProps = { labels: Labels };

export function ImportWizard({ labels }: ImportWizardProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [provider, setProvider] = useState<Provider>("typeform");
  const [name, setName] = useState("");
  const [person, setPerson] = useState<PersonPaths>(PRESETS.typeform.person);
  const [fields, setFields] = useState<FieldRow[]>(PRESETS.typeform.fields);
  const [outcomes, setOutcomes] = useState<OutcomeRow[]>([]);
  const [consents, setConsents] = useState<Partial<Record<FormConsentPurpose, string>>>(PRESETS.typeform.consents);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [createdUrl, setCreatedUrl] = useState<string | null>(null);

  const applyPreset = (p: Provider) => {
    setProvider(p);
    setPerson(PRESETS[p].person);
    setFields(PRESETS[p].fields);
    setConsents(PRESETS[p].consents);
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    setErrors({});
    const opt = (v: string) => (v.trim() ? v.trim() : undefined);
    const mapping: ImportMapping = {
      email: person.email.trim(),
      externalId: person.externalId.trim(),
      answers: Object.fromEntries(fields.filter((f) => f.key && f.path).map((f) => [f.key, f.path.trim()])),
      sensitiveFieldKeys: fields.filter((f) => f.sensitive && f.key).map((f) => f.key),
    };
    for (const k of ["firstName", "lastName", "phone", "locale", "completedAt", "score", "outcome"] as const) {
      const v = opt(person[k]);
      if (v) mapping[k] = v;
    }
    const outcomeRows = outcomes.filter((o) => o.key.trim());
    if (outcomeRows.length) mapping.outcomeMap = Object.fromEntries(outcomeRows.filter((o) => o.external.trim()).map((o) => [o.external.trim(), o.key.trim()]));
    const consentPaths = Object.fromEntries(Object.entries(consents).filter(([, v]) => v?.trim()).map(([k, v]) => [k, v!.trim()]));
    if (Object.keys(consentPaths).length) mapping.consents = consentPaths;
    const r = await createImportSource({
      provider,
      name: name.trim(),
      mapping,
      mirrorFields: fields.filter((f) => f.key).map(mirrorField),
      ...(outcomeRows.length ? { outcomes: outcomeRows.map((o) => ({ key: o.key.trim(), label: o.label.trim() || o.key.trim(), tagKeys: [] })) } : {}),
    });
    setBusy(false);
    if (r.ok) {
      setCreatedUrl(r.data.url);
      toast.success(lbl(labels, "imports.wizard.created"));
      router.refresh();
      return;
    }
    setErrors(r.error.fields ?? {});
    const code = r.error.message === "publish_refused" ? "publish_refused" : r.error.code;
    setError(labels[`imports.error.${code}`] ?? lbl(labels, "imports.error.internal"));
  };

  if (createdUrl) {
    return (
      <div className="grid gap-2 rounded-md border border-warning p-4" role="status">
        <p className="font-medium">{lbl(labels, "imports.secret_once")}</p>
        <code className="break-all rounded bg-muted p-2 text-sm">{createdUrl}</code>
        <div className="flex gap-2">
          <Button type="button" variant="outline" onClick={() => void navigator.clipboard?.writeText(createdUrl).then(() => toast.success(lbl(labels, "imports.copied")))}>
            {lbl(labels, "imports.copy")}
          </Button>
          <Button type="button" onClick={() => { setCreatedUrl(null); setOpen(false); setName(""); }}>
            {lbl(labels, "imports.done")}
          </Button>
        </div>
      </div>
    );
  }
  if (!open) {
    return (
      <div>
        <Button type="button" onClick={() => setOpen(true)}>
          {lbl(labels, "imports.new")}
        </Button>
      </div>
    );
  }

  const pathInput = (k: keyof PersonPaths, required = false) => (
    <label key={k} className="grid gap-1 text-sm">
      {lbl(labels, `imports.wizard.${k === "firstName" ? "first_name" : k === "lastName" ? "last_name" : k === "externalId" ? "external_id" : k === "completedAt" ? "completed_at" : k}_path`)}
      <Input
        value={person[k]}
        required={required}
        maxLength={300}
        aria-invalid={errors[`mapping.${k}`] ? true : undefined}
        onChange={(e) => setPerson({ ...person, [k]: e.target.value })}
      />
    </label>
  );

  return (
    <form
      className="grid gap-5 rounded-md border p-4"
      aria-label={lbl(labels, "imports.wizard.title")}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <h2 className="text-lg font-semibold">{lbl(labels, "imports.wizard.title")}</h2>
      <fieldset className="grid gap-3">
        <legend className="mb-2 font-medium">{lbl(labels, "imports.wizard.step_source")}</legend>
        <div className="flex flex-wrap items-end gap-3">
          <label className="grid gap-1 text-sm">
            {lbl(labels, "imports.provider")}
            <select className={selectClass} value={provider} onChange={(e) => applyPreset(e.target.value as Provider)}>
              <option value="typeform">{lbl(labels, "imports.provider_typeform")}</option>
              <option value="scoreapp">{lbl(labels, "imports.provider_scoreapp")}</option>
            </select>
          </label>
          <label className="grid gap-1 text-sm">
            {lbl(labels, "imports.name")}
            <Input required value={name} maxLength={120} onChange={(e) => setName(e.target.value)} aria-invalid={errors.name ? true : undefined} />
          </label>
        </div>
        <p className="text-xs text-muted-foreground">{lbl(labels, "imports.wizard.path_help")}</p>
      </fieldset>

      <fieldset className="grid gap-3">
        <legend className="mb-2 font-medium">{lbl(labels, "imports.wizard.step_person")}</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          {pathInput("email", true)}
          {pathInput("externalId", true)}
          {pathInput("firstName")}
          {pathInput("lastName")}
          {pathInput("phone")}
          {pathInput("locale")}
          {pathInput("completedAt")}
        </div>
      </fieldset>

      <fieldset className="grid gap-3">
        <legend className="mb-2 font-medium">{lbl(labels, "imports.wizard.step_fields")}</legend>
        <p className="text-xs text-muted-foreground">{lbl(labels, "imports.wizard.sensitive_help")}</p>
        {fields.map((f, n) => (
          <div key={n} className="flex flex-wrap items-end gap-2">
            <label className="grid gap-1 text-sm">
              {lbl(labels, "imports.wizard.field_key")}
              <Input className="w-36" value={f.key} pattern="[a-z][a-z0-9_]{0,39}" onChange={(e) => setFields(fields.map((x, i) => (i === n ? { ...x, key: e.target.value } : x)))} />
            </label>
            <label className="grid gap-1 text-sm">
              {lbl(labels, "imports.wizard.field_label")}
              <Input className="w-40" value={f.label} maxLength={200} onChange={(e) => setFields(fields.map((x, i) => (i === n ? { ...x, label: e.target.value } : x)))} />
            </label>
            <label className="grid gap-1 text-sm">
              {lbl(labels, "imports.wizard.field_type")}
              <select className={selectClass} value={f.type} onChange={(e) => setFields(fields.map((x, i) => (i === n ? { ...x, type: e.target.value as MirrorType } : x)))}>
                {FIELD_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {lbl(labels, `imports.wizard.type_${t}`)}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid flex-1 gap-1 text-sm">
              {lbl(labels, "imports.wizard.field_path")}
              <Input value={f.path} maxLength={300} aria-invalid={errors[`mapping.answers.${f.key}`] ? true : undefined} onChange={(e) => setFields(fields.map((x, i) => (i === n ? { ...x, path: e.target.value } : x)))} />
            </label>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={f.sensitive} onCheckedChange={(v) => setFields(fields.map((x, i) => (i === n ? { ...x, sensitive: v === true } : x)))} />
              {lbl(labels, "imports.wizard.field_sensitive")}
            </label>
            <Button type="button" variant="ghost" size="sm" onClick={() => setFields(fields.filter((_, i) => i !== n))}>
              {lbl(labels, "imports.wizard.remove")}
            </Button>
          </div>
        ))}
        <div>
          <Button type="button" variant="outline" size="sm" onClick={() => setFields([...fields, { key: "", label: "", type: "short_text", path: "", sensitive: false }])}>
            {lbl(labels, "imports.wizard.add_field")}
          </Button>
        </div>
      </fieldset>

      <fieldset className="grid gap-3">
        <legend className="mb-2 font-medium">{lbl(labels, "imports.wizard.step_result")}</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          {pathInput("score")}
          {pathInput("outcome")}
        </div>
        {outcomes.map((o, n) => (
          <div key={n} className="flex flex-wrap items-end gap-2">
            <label className="grid gap-1 text-sm">
              {lbl(labels, "imports.wizard.outcome_external")}
              <Input className="w-48" value={o.external} maxLength={200} onChange={(e) => setOutcomes(outcomes.map((x, i) => (i === n ? { ...x, external: e.target.value } : x)))} />
            </label>
            <label className="grid gap-1 text-sm">
              {lbl(labels, "imports.wizard.outcome_key")}
              <Input className="w-36" value={o.key} pattern="[a-z][a-z0-9_]{0,39}" onChange={(e) => setOutcomes(outcomes.map((x, i) => (i === n ? { ...x, key: e.target.value } : x)))} />
            </label>
            <label className="grid gap-1 text-sm">
              {lbl(labels, "imports.wizard.outcome_label")}
              <Input className="w-40" value={o.label} maxLength={120} onChange={(e) => setOutcomes(outcomes.map((x, i) => (i === n ? { ...x, label: e.target.value } : x)))} />
            </label>
            <Button type="button" variant="ghost" size="sm" onClick={() => setOutcomes(outcomes.filter((_, i) => i !== n))}>
              {lbl(labels, "imports.wizard.remove")}
            </Button>
          </div>
        ))}
        <div>
          <Button type="button" variant="outline" size="sm" onClick={() => setOutcomes([...outcomes, { key: "", label: "", external: "" }])}>
            {lbl(labels, "imports.wizard.add_outcome")}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">{lbl(labels, "imports.wizard.consents_help")}</p>
        <div className="grid gap-3 sm:grid-cols-2">
          {FORM_CONSENT_PURPOSES.map((p) => (
            <label key={p} className="grid gap-1 text-sm">
              {lbl(labels, `imports.consent.${p}`)}
              <Input value={consents[p] ?? ""} maxLength={300} onChange={(e) => setConsents({ ...consents, [p]: e.target.value })} />
            </label>
          ))}
        </div>
      </fieldset>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button type="submit" disabled={busy || !name.trim() || !person.email.trim() || !person.externalId.trim()}>
          {lbl(labels, "imports.wizard.create")}
        </Button>
        <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
          {lbl(labels, "imports.wizard.cancel")}
        </Button>
      </div>
    </form>
  );
}

/** Activates or deactivates a source (a deactivated source's URL answers 404, rule I1). */
export function ImportSourceToggle({ sourceId, isActive, labels }: { sourceId: string; isActive: boolean; labels: Labels }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      type="button"
      size="sm"
      variant={isActive ? "outline" : "default"}
      disabled={busy}
      onClick={() => {
        void (async () => {
          setBusy(true);
          const r = await updateImportSource({ sourceId, isActive: !isActive });
          setBusy(false);
          if (r.ok) {
            toast.success(lbl(labels, isActive ? "imports.deactivated" : "imports.activated"));
            router.refresh();
          } else toast.error(labels[`imports.error.${r.error.code}`] ?? lbl(labels, "imports.error.internal"));
        })();
      }}
    >
      {lbl(labels, isActive ? "imports.deactivate" : "imports.activate")}
    </Button>
  );
}
