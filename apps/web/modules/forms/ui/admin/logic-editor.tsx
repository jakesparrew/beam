"use client";

/**
 * Logic rules per section (rules L2, L3, L6; forms-P5) and the form settings tab (F1). A rule runs
 * after its section: the first matching rule jumps forward (`goto` a later section) or ends the
 * form (`end` with an ending). Conditions may reference earlier fields only; sensitive fields are
 * left out of the field list, since logic on them is a publish error (L6).
 */
import { LOCALES, type Locale, type LocalizedText } from "@beam/core/i18n";
import type { FormDefinition, FormSettings, LogicRule } from "@beam/core/forms";
import { Button, Input, LocalizedInput, Switch } from "@beam/ui";
import { ConditionBuilder, selectClass, type ConditionDimensionRef, type ConditionFieldRef } from "./condition-builder";
import { textLabels } from "./field-editor";
import { lbl, type Labels } from "./issues-panel";

export type LogicEditorProps = {
  definition: FormDefinition;
  onChange: (logic: LogicRule[]) => void;
  labels: Labels;
  /** Non-sensitive fields per section key, in order (the caller filters L4 and L6). */
  fieldsBefore: (sectionKey: string) => ConditionFieldRef[];
  dimensions: readonly ConditionDimensionRef[];
  sectionTitle: (key: string) => string;
};

export function LogicEditor({ definition, onChange, labels, fieldsBefore, dimensions, sectionTitle }: LogicEditorProps) {
  const rules = definition.logic;
  const sections = definition.sections;
  const set = (i: number, r: LogicRule) => onChange(rules.map((x, j) => (j === i ? r : x)));
  const nextKey = () => {
    let n = rules.length + 1;
    while (rules.some((r) => r.key === `rule_${n}`)) n++;
    return `rule_${n}`;
  };
  return (
    <div className="grid gap-4">
      {sections.map((s, si) => {
        const own = rules.map((r, i) => ({ r, i })).filter(({ r }) => r.afterSection === s.key);
        const later = sections.slice(si + 1);
        return (
          <section key={s.key} className="grid gap-2" aria-label={lbl(labels, "builder.logic.after", { section: sectionTitle(s.key) })}>
            <h3 className="text-sm font-medium">{lbl(labels, "builder.logic.after", { section: sectionTitle(s.key) })}</h3>
            {own.map(({ r, i }) => {
              const isGoto = "goto" in r.then;
              return (
                <div key={r.key} className="grid gap-2 rounded-md border p-2" data-logic-rule={r.key}>
                  <ConditionBuilder legend={lbl(labels, "builder.logic.if")} value={r.if} onChange={(c) => set(i, { ...r, if: c ?? { all: [] } })} fields={fieldsBefore(s.key)} dimensions={dimensions} labels={labels} />
                  <div className="flex flex-wrap items-center gap-2">
                    <select aria-label={lbl(labels, "builder.logic.then")} className={selectClass} value={isGoto ? "goto" : "end"} onChange={(e) => set(i, { ...r, then: e.target.value === "goto" ? { goto: later[0]?.key ?? "" } : { end: definition.endings[0]?.key ?? "" } })}>
                      <option value="goto">{lbl(labels, "builder.logic.goto")}</option>
                      <option value="end">{lbl(labels, "builder.logic.end")}</option>
                    </select>
                    {"goto" in r.then ? (
                      <select aria-label={lbl(labels, "builder.logic.target_section")} className={selectClass} value={r.then.goto} onChange={(e) => set(i, { ...r, then: { goto: e.target.value } })}>
                        {later.map((x) => (
                          <option key={x.key} value={x.key}>
                            {sectionTitle(x.key)}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <select aria-label={lbl(labels, "builder.logic.target_ending")} className={selectClass} value={r.then.end} onChange={(e) => set(i, { ...r, then: { end: e.target.value } })}>
                        {definition.endings.map((x) => (
                          <option key={x.key} value={x.key}>
                            {x.key}
                          </option>
                        ))}
                      </select>
                    )}
                    <Button type="button" variant="ghost" size="sm" disabled={i === 0} onClick={() => onChange(rules.map((x, j) => (j === i - 1 ? rules[i]! : j === i ? rules[i - 1]! : x)))}>
                      {lbl(labels, "builder.move_up")}
                    </Button>
                    <Button type="button" variant="ghost" size="sm" onClick={() => onChange(rules.filter((_, j) => j !== i))}>
                      {lbl(labels, "builder.remove")}
                    </Button>
                  </div>
                </div>
              );
            })}
            <div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => onChange([...rules, { key: nextKey(), afterSection: s.key, if: { all: [] }, then: later[0] ? { goto: later[0].key } : { end: definition.endings[0]?.key ?? "" } }])}
              >
                {lbl(labels, "builder.logic.add")}
              </Button>
            </div>
          </section>
        );
      })}
    </div>
  );
}

export type SettingsEditorProps = {
  settings: FormSettings;
  onChange: (s: FormSettings) => void;
  locales: Locale[];
  onLocalesChange: (l: Locale[]) => void;
  localeNames: Record<Locale, string>;
  labels: Labels;
};

const FLAGS = ["resumeEnabled", "skipKnownFields", "capturePartialLeads", "showProgress", "sendResultEmail", "createInboxThread", "staffEntryAllowed"] as const;

/** F1 settings and the version's locales. */
export function SettingsEditor({ settings, onChange, locales, onLocalesChange, localeNames, labels }: SettingsEditorProps) {
  const tl = textLabels(labels, localeNames);
  return (
    <div className="grid gap-4">
      <fieldset className="grid gap-2">
        <legend className="text-sm font-medium">{lbl(labels, "builder.settings.locales")}</legend>
        {LOCALES.map((l) => (
          <label key={l} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={locales.includes(l)}
              disabled={locales.length === 1 && locales.includes(l)}
              onChange={(e) => onLocalesChange(e.target.checked ? LOCALES.filter((x) => x === l || locales.includes(x)) : locales.filter((x) => x !== l))}
            />
            {localeNames[l]}
          </label>
        ))}
      </fieldset>
      {FLAGS.map((k) => (
        <label key={k} className="flex items-center gap-2 text-sm">
          <Switch checked={settings[k]} onCheckedChange={(v) => onChange({ ...settings, [k]: v })} aria-label={lbl(labels, `builder.settings.${k}`)} />
          {lbl(labels, `builder.settings.${k}`)}
        </label>
      ))}
      <div className="flex flex-wrap gap-4">
        <label className="grid gap-1 text-sm">
          {lbl(labels, "builder.settings.resumeDays")}
          <Input type="number" min={1} max={30} className="w-24" value={settings.resumeDays} onChange={(e) => onChange({ ...settings, resumeDays: Number(e.target.value) || 7 })} />
        </label>
        <label className="grid gap-1 text-sm">
          {lbl(labels, "builder.settings.validityDays")}
          <Input
            type="number"
            min={1}
            max={1095}
            className="w-28"
            value={settings.validityDays ?? ""}
            onChange={(e) => {
              const { validityDays: _v, ...rest } = settings;
              onChange(e.target.value ? { ...rest, validityDays: Number(e.target.value) } : rest);
            }}
          />
        </label>
        <label className="grid gap-1 text-sm">
          {lbl(labels, "builder.settings.funnel")}
          <Input
            className="w-48 font-mono"
            value={settings.funnel ?? ""}
            onChange={(e) => {
              const { funnel: _f, ...rest } = settings;
              onChange(e.target.value ? { ...rest, funnel: e.target.value } : rest);
            }}
          />
        </label>
      </div>
      <LocalizedInput name="submit-label" value={settings.submitLabel} locales={locales} labels={tl("builder.settings.submitLabel")} onChange={(v) => onChange({ ...settings, submitLabel: v as LocalizedText })} />
    </div>
  );
}
