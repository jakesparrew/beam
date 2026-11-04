"use client";

/**
 * Field editor (rules F2, F6, L6; forms-P5): label, help, required, the type's own properties
 * (options with scores, scale, min/max, consent purpose and wording, acknowledgement text, hidden
 * and UTM parameters), `mapsTo`, the sensitive toggle with its kind, and the visibility condition.
 * Unticking "sensitive" on a long text of an assessment or intake form asks for confirmation (F6);
 * the builder records it in the version's change note.
 */
import { useState } from "react";
import { FORM_CONSENT_PURPOSES, MAPS_TO, SENSITIVE_KINDS, UTM_PARAMS, type ChoiceOption, type Field, type FormKind } from "@beam/core/forms";
import type { Locale } from "@beam/core/i18n";
import { Button, Input, Label, LocalizedInput, Switch } from "@beam/ui";
import { ConditionBuilder, selectClass, type ConditionDimensionRef, type ConditionFieldRef } from "./condition-builder";
import { lbl, type Labels } from "./issues-panel";

export type TextInputLabels = (field: string) => { field: string; locales: Record<Locale, string>; missing: string; complete: string };

/** LocalizedInput labels for a field label key (shared by every builder component). */
export function textLabels(labels: Labels, localeNames: Record<Locale, string>): TextInputLabels {
  return (field) => ({ field: lbl(labels, field), locales: localeNames, missing: lbl(labels, "builder.locale_missing"), complete: lbl(labels, "builder.locale_complete") });
}

export type FieldEditorProps = {
  field: Field;
  onChange: (field: Field) => void;
  onSensitiveUnticked?: (fieldKey: string) => void;
  kind: FormKind;
  locales: Locale[];
  localeNames: Record<Locale, string>;
  labels: Labels;
  /** Fields a visibility condition may reference (earlier ones, L4). */
  conditionFields: readonly ConditionFieldRef[];
  dimensions: readonly ConditionDimensionRef[];
  /** Dimension keys a choice option or a weight may score. */
  dimensionKeys: readonly string[];
};

const CHOICE = new Set(["single_choice", "multiple_choice", "dropdown"]);

function Scores({ value, keys, onChange, labels, name }: { value: Record<string, number> | undefined; keys: readonly string[]; onChange: (v: Record<string, number> | undefined) => void; labels: Labels; name: string }) {
  if (!keys.length) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {keys.map((k) => (
        <label key={k} className="flex items-center gap-1 text-xs">
          <span>{k}</span>
          <Input
            type="number"
            aria-label={`${name} ${lbl(labels, "builder.field.score_for", { dimension: k })}`}
            className="h-8 w-20"
            value={value?.[k] ?? ""}
            onChange={(e) => {
              const next = { ...(value ?? {}) };
              if (e.target.value === "") delete next[k];
              else next[k] = Number(e.target.value);
              onChange(Object.keys(next).length ? next : undefined);
            }}
          />
        </label>
      ))}
    </div>
  );
}

function Options({ options, onChange, p }: { options: ChoiceOption[]; onChange: (o: ChoiceOption[]) => void; p: FieldEditorProps }) {
  const tl = textLabels(p.labels, p.localeNames);
  return (
    <fieldset className="grid gap-3">
      <legend className="text-sm font-medium">{lbl(p.labels, "builder.field.options")}</legend>
      {options.map((o, i) => (
        <div key={i} className="grid gap-2 rounded-md border p-2">
          <div className="flex flex-wrap items-end gap-2">
            <label className="grid gap-1 text-xs">
              {lbl(p.labels, "builder.key")}
              <Input className="h-8 w-40 font-mono" value={o.key} onChange={(e) => onChange(options.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))} />
            </label>
            <Button type="button" variant="ghost" size="sm" disabled={i === 0} onClick={() => onChange(options.map((x, j) => (j === i - 1 ? options[i]! : j === i ? options[i - 1]! : x)))}>
              {lbl(p.labels, "builder.move_up")}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => onChange(options.filter((_, j) => j !== i))}>
              {lbl(p.labels, "builder.remove")}
            </Button>
          </div>
          <LocalizedInput name={`option-${i}`} value={o.label} locales={p.locales} labels={tl("builder.field.option_label")} onChange={(label) => onChange(options.map((x, j) => (j === i ? { ...x, label: label } : x)))} />
          <Scores name={o.key} keys={p.dimensionKeys} value={o.scores} labels={p.labels} onChange={(scores) => onChange(options.map((x, j) => (j === i ? { key: x.key, label: x.label, ...(scores ? { scores } : {}) } : x)))} />
        </div>
      ))}
      <div>
        <Button type="button" variant="outline" size="sm" onClick={() => onChange([...options, { key: `option_${options.length + 1}`, label: {} }])}>
          {lbl(p.labels, "builder.field.add_option")}
        </Button>
      </div>
    </fieldset>
  );
}

const num = (v: string): number | undefined => (v === "" || Number.isNaN(Number(v)) ? undefined : Number(v));

function NumberProp({ label, value, onChange }: { label: string; value: number | undefined; onChange: (v: number | undefined) => void }) {
  return (
    <label className="grid gap-1 text-sm">
      {label}
      <Input type="number" className="w-32" value={value ?? ""} onChange={(e) => onChange(num(e.target.value))} />
    </label>
  );
}

export function FieldEditor(p: FieldEditorProps) {
  const { field: f, onChange, labels } = p;
  const tl = textLabels(labels, p.localeNames);
  const [confirmUntick, setConfirmUntick] = useState(false);
  const set = (patch: Partial<Field>) => onChange({ ...f, ...patch } as Field);
  const longTextDefault = f.type === "long_text" && (p.kind === "assessment" || p.kind === "intake");

  return (
    <div className="grid gap-4" data-field-editor={f.key}>
      <div className="flex flex-wrap items-end gap-4">
        <div className="grid gap-1 text-sm">
          <span>{lbl(labels, "builder.key")}</span>
          <code className="rounded bg-muted px-2 py-1">{f.key}</code>
        </div>
        <div className="grid gap-1 text-sm">
          <span>{lbl(labels, "builder.field.type")}</span>
          <span>{lbl(labels, `builder.type.${f.type}`)}</span>
        </div>
        {f.type !== "acknowledgement" ? (
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={f.required} onCheckedChange={(v) => set({ required: v })} aria-label={lbl(labels, "builder.field.required")} />
            {lbl(labels, "builder.field.required")}
          </label>
        ) : null}
      </div>

      <LocalizedInput name={`${f.key}-label`} value={f.label} locales={p.locales} labels={tl("builder.field.label")} onChange={(label) => set({ label: label })} />
      <LocalizedInput name={`${f.key}-help`} value={f.help ?? {}} locales={p.locales} labels={tl("builder.field.help")} onChange={(help) => set({ help: help })} />

      {CHOICE.has(f.type) && "options" in f ? <Options options={f.options} onChange={(options) => set({ options })} p={p} /> : null}
      {f.type === "multiple_choice" ? (
        <div className="flex gap-4">
          <NumberProp label={lbl(labels, "builder.field.min_selected")} value={f.minSelected} onChange={(minSelected) => set({ minSelected })} />
          <NumberProp label={lbl(labels, "builder.field.max_selected")} value={f.maxSelected} onChange={(maxSelected) => set({ maxSelected })} />
        </div>
      ) : null}
      {f.type === "yes_no" ? (
        <div className="grid gap-2">
          <span className="text-sm font-medium">{lbl(labels, "builder.field.scores")}</span>
          <div className="text-xs">{lbl(labels, "builder.field.yes")}</div>
          <Scores name="yes" keys={p.dimensionKeys} value={f.scores?.yes} labels={labels} onChange={(yes) => set({ scores: { ...f.scores, yes } })} />
          <div className="text-xs">{lbl(labels, "builder.field.no")}</div>
          <Scores name="no" keys={p.dimensionKeys} value={f.scores?.no} labels={labels} onChange={(no) => set({ scores: { ...f.scores, no } })} />
        </div>
      ) : null}
      {f.type === "rating" ? (
        <label className="grid gap-1 text-sm">
          {lbl(labels, "builder.field.scale")}
          <select className={selectClass} value={f.scale} onChange={(e) => set({ scale: Number(e.target.value) as 5 | 10 })}>
            <option value={5}>5</option>
            <option value={10}>10</option>
          </select>
        </label>
      ) : null}
      {f.type === "number" ? (
        <div className="flex flex-wrap gap-4">
          <NumberProp label={lbl(labels, "builder.field.min")} value={f.min} onChange={(min) => set({ min })} />
          <NumberProp label={lbl(labels, "builder.field.max")} value={f.max} onChange={(max) => set({ max })} />
          <NumberProp label={lbl(labels, "builder.field.step")} value={f.step} onChange={(step) => set({ step })} />
        </div>
      ) : null}
      {f.type === "rating" || f.type === "number" ? (
        <div className="grid gap-1">
          <span className="text-sm font-medium">{lbl(labels, "builder.field.weights")}</span>
          <Scores name={f.key} keys={p.dimensionKeys} value={f.weights} labels={labels} onChange={(weights) => set({ weights })} />
        </div>
      ) : null}
      {f.type === "date" ? (
        <div className="flex gap-4">
          <label className="grid gap-1 text-sm">
            {lbl(labels, "builder.field.min")}
            <Input type="date" value={f.min ?? ""} onChange={(e) => set({ min: e.target.value || undefined })} />
          </label>
          <label className="grid gap-1 text-sm">
            {lbl(labels, "builder.field.max")}
            <Input type="date" value={f.max ?? ""} onChange={(e) => set({ max: e.target.value || undefined })} />
          </label>
        </div>
      ) : null}
      {f.type === "consent" ? (
        <>
          <label className="grid gap-1 text-sm">
            {lbl(labels, "builder.field.purpose")}
            <select className={selectClass} value={f.purpose} onChange={(e) => set({ purpose: e.target.value } as Partial<Field>)}>
              {FORM_CONSENT_PURPOSES.map((x) => (
                <option key={x} value={x}>
                  {lbl(labels, `builder.purpose.${x}`)}
                </option>
              ))}
            </select>
          </label>
          <LocalizedInput name={`${f.key}-wording`} multiline value={f.wording} locales={p.locales} labels={tl("builder.field.wording")} onChange={(wording) => set({ wording: wording })} />
        </>
      ) : null}
      {f.type === "acknowledgement" ? (
        <LocalizedInput name={`${f.key}-text`} multiline value={f.text} locales={p.locales} labels={tl("builder.field.ack_text")} onChange={(text) => set({ text: text })} />
      ) : null}
      {f.type === "hidden" ? (
        <div className="flex flex-wrap gap-4">
          <label className="grid gap-1 text-sm">
            {lbl(labels, "builder.field.hidden_from")}
            <select className={selectClass} value={f.from} onChange={(e) => set({ from: e.target.value as "query" | "constant" })}>
              <option value="query">{lbl(labels, "builder.field.from_query")}</option>
              <option value="constant">{lbl(labels, "builder.field.from_constant")}</option>
            </select>
          </label>
          {f.from === "query" ? (
            <label className="grid gap-1 text-sm">
              {lbl(labels, "builder.field.param")}
              <Input className="font-mono" value={f.param ?? ""} onChange={(e) => set({ param: e.target.value || undefined })} />
            </label>
          ) : (
            <label className="grid gap-1 text-sm">
              {lbl(labels, "builder.field.value")}
              <Input value={f.value ?? ""} onChange={(e) => set({ value: e.target.value })} />
            </label>
          )}
        </div>
      ) : null}
      {f.type === "utm" ? (
        <label className="grid gap-1 text-sm">
          {lbl(labels, "builder.field.param")}
          <select className={selectClass} value={f.param} onChange={(e) => set({ param: e.target.value })}>
            {UTM_PARAMS.map((x) => (
              <option key={x} value={x}>
                {x}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      {f.type !== "consent" && f.type !== "acknowledgement" && f.type !== "utm" ? (
        <label className="grid gap-1 text-sm">
          {lbl(labels, "builder.field.maps_to")}
          <select className={selectClass} value={f.mapsTo ?? ""} onChange={(e) => set({ mapsTo: (e.target.value || undefined) as Field["mapsTo"] })}>
            <option value="">{lbl(labels, "builder.field.maps_none")}</option>
            {MAPS_TO.map((m) => (
              <option key={m} value={m}>
                {lbl(labels, `builder.maps.${m.replace(".", "_")}`)}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      <div className="grid gap-2 rounded-md border p-3">
        <div className="flex items-center gap-2 text-sm">
          <Switch
            checked={f.sensitive}
            aria-label={lbl(labels, "builder.field.sensitive")}
            onCheckedChange={(v) => {
              if (!v && longTextDefault) setConfirmUntick(true);
              else set({ sensitive: v, ...(v ? {} : { sensitiveKind: undefined }) });
            }}
          />
          <Label>{lbl(labels, "builder.field.sensitive")}</Label>
        </div>
        <p className="text-xs text-muted-foreground">{lbl(labels, "builder.field.sensitive_help")}</p>
        {confirmUntick ? (
          <div role="alertdialog" aria-label={lbl(labels, "builder.field.untick_title")} className="grid gap-2 rounded-md bg-muted p-2 text-sm">
            <p>{lbl(labels, "builder.field.untick_body")}</p>
            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                variant="destructive"
                onClick={() => {
                  setConfirmUntick(false);
                  set({ sensitive: false, sensitiveKind: undefined });
                  p.onSensitiveUnticked?.(f.key);
                }}
              >
                {lbl(labels, "builder.field.untick_confirm")}
              </Button>
              <Button type="button" size="sm" variant="outline" onClick={() => setConfirmUntick(false)}>
                {lbl(labels, "builder.cancel")}
              </Button>
            </div>
          </div>
        ) : null}
        {f.sensitive ? (
          <label className="grid gap-1 text-sm">
            {lbl(labels, "builder.field.sensitive_kind")}
            <select className={selectClass} value={f.sensitiveKind ?? ""} onChange={(e) => set({ sensitiveKind: (e.target.value || undefined) as Field["sensitiveKind"] })}>
              <option value="">—</option>
              {SENSITIVE_KINDS.map((k) => (
                <option key={k} value={k}>
                  {lbl(labels, `builder.sensitive_kind.${k}`)}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>

      <ConditionBuilder
        legend={lbl(labels, "builder.field.visible_if")}
        value={f.visibleIf}
        onChange={(visibleIf) => set({ visibleIf })}
        fields={p.conditionFields}
        dimensions={p.dimensions}
        labels={labels}
      />
    </div>
  );
}
