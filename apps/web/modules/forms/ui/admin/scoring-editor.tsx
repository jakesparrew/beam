"use client";

/**
 * Scoring (rules S1 to S7; forms spec section 5 `/admin/forms/[formId]/scoring`; forms-P5):
 * dimensions with kind, formula and ranges, the total, and outcomes in priority order with their
 * condition over scores, ranges and answers, ending and tags. Saved with the draft through
 * `saveDraft` (the same autosave as the builder). Outcomes are visible to marketing (S7).
 */
import { useState } from "react";
import type { Dimension, Field, FormDefinition, FormKind, FormScoring, Outcome, Range } from "@beam/core/forms";
import type { Locale } from "@beam/core/i18n";
import { Button, EmptyState, Input, LocalizedInput } from "@beam/ui";
import { ConditionBuilder, selectClass, type ConditionDimensionRef, type ConditionFieldRef } from "./condition-builder";
import { ConflictDialog, SaveIndicator, useDraft, type DraftInput } from "./field-tree";
import { textLabels } from "./field-editor";
import { FormulaInput } from "./formula-input";
import { IssuesPanel, lbl, type Labels } from "./issues-panel";

type P = { labels: Labels; locales: Locale[]; localeNames: Record<Locale, string> };

const nextKey = (base: string, taken: readonly string[]) => {
  let n = taken.length + 1;
  while (taken.includes(`${base}_${n}`)) n++;
  return `${base}_${n}`;
};

function Ranges({ ranges, onChange, p }: { ranges: Range[]; onChange: (r: Range[]) => void; p: P }) {
  const tl = textLabels(p.labels, p.localeNames);
  const set = (i: number, patch: Partial<Range>) => onChange(ranges.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <fieldset className="grid gap-2">
      <legend className="text-sm font-medium">{lbl(p.labels, "scoring.ranges")}</legend>
      {ranges.map((r, i) => (
        <div key={i} className="grid gap-2 rounded-md border p-2">
          <div className="flex flex-wrap items-end gap-2">
            <label className="grid gap-1 text-xs">
              {lbl(p.labels, "builder.key")}
              <Input className="h-8 w-28 font-mono" value={r.key} onChange={(e) => set(i, { key: e.target.value })} />
            </label>
            <label className="grid gap-1 text-xs">
              {lbl(p.labels, "scoring.from")}
              <Input type="number" className="h-8 w-20" value={r.from} onChange={(e) => set(i, { from: Number(e.target.value) })} />
            </label>
            <label className="grid gap-1 text-xs">
              {lbl(p.labels, "scoring.to")}
              <Input type="number" className="h-8 w-20" value={r.to} onChange={(e) => set(i, { to: Number(e.target.value) })} />
            </label>
            <Button type="button" variant="ghost" size="sm" onClick={() => onChange(ranges.filter((_, j) => j !== i))}>
              {lbl(p.labels, "builder.remove")}
            </Button>
          </div>
          <LocalizedInput name={`range-${r.key}-label`} value={r.label} locales={p.locales} labels={tl("scoring.range_label")} onChange={(label) => set(i, { label: label })} />
          <LocalizedInput name={`range-${r.key}-explanation`} multiline value={r.explanation ?? {}} locales={p.locales} labels={tl("scoring.explanation")} onChange={(v) => set(i, { explanation: v })} />
          <LocalizedInput name={`range-${r.key}-recommendation`} multiline value={r.recommendation ?? {}} locales={p.locales} labels={tl("scoring.recommendation")} onChange={(v) => set(i, { recommendation: v })} />
        </div>
      ))}
      <div>
        <Button type="button" variant="outline" size="sm" onClick={() => onChange([...ranges, { key: nextKey("range", ranges.map((r) => r.key)), from: ranges.at(-1)?.to ?? 0, to: (ranges.at(-1)?.to ?? 0) + 1, label: {} }])}>
          {lbl(p.labels, "scoring.add_range")}
        </Button>
      </div>
    </fieldset>
  );
}

function DimensionEditor({ d, onChange, onRemove, p }: { d: Dimension; onChange: (d: Dimension) => void; onRemove: () => void; p: P }) {
  const tl = textLabels(p.labels, p.localeNames);
  return (
    <section className="grid gap-3 rounded-md border p-3" aria-label={d.key} data-dimension={d.key}>
      <div className="flex flex-wrap items-end gap-2">
        <label className="grid gap-1 text-xs">
          {lbl(p.labels, "builder.key")}
          <Input className="h-8 w-32 font-mono" value={d.key} onChange={(e) => onChange({ ...d, key: e.target.value })} />
        </label>
        <label className="grid gap-1 text-xs">
          {lbl(p.labels, "scoring.kind")}
          <select className={selectClass} value={d.kind} onChange={(e) => onChange({ ...d, kind: e.target.value as Dimension["kind"] })}>
            {(["sum", "avg", "formula"] as const).map((k) => (
              <option key={k} value={k}>
                {lbl(p.labels, `scoring.kind_${k}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-xs">
          {lbl(p.labels, "scoring.min")}
          <Input type="number" className="h-8 w-20" value={d.min ?? ""} onChange={(e) => onChange({ ...d, min: e.target.value === "" ? undefined : Number(e.target.value) })} />
        </label>
        <label className="grid gap-1 text-xs">
          {lbl(p.labels, "scoring.max")}
          <Input type="number" className="h-8 w-20" value={d.max ?? ""} onChange={(e) => onChange({ ...d, max: e.target.value === "" ? undefined : Number(e.target.value) })} />
        </label>
        <Button type="button" variant="ghost" size="sm" onClick={onRemove}>
          {lbl(p.labels, "builder.remove")}
        </Button>
      </div>
      <LocalizedInput name={`dim-${d.key}-label`} value={d.label} locales={p.locales} labels={tl("scoring.dimension_label")} onChange={(label) => onChange({ ...d, label: label })} />
      {d.kind === "formula" ? <FormulaInput label={lbl(p.labels, "scoring.formula")} value={d.formula ?? ""} onChange={(formula) => onChange({ ...d, formula })} labels={p.labels} /> : null}
      <Ranges ranges={d.ranges} onChange={(ranges) => onChange({ ...d, ranges })} p={p} />
    </section>
  );
}

function OutcomeEditor({ o, onChange, onRemove, p, endings, fields, dims }: { o: Outcome; onChange: (o: Outcome) => void; onRemove: () => void; p: P; endings: string[]; fields: ConditionFieldRef[]; dims: ConditionDimensionRef[] }) {
  const tl = textLabels(p.labels, p.localeNames);
  return (
    <section className="grid gap-3 rounded-md border p-3" aria-label={o.key} data-outcome={o.key}>
      <div className="flex flex-wrap items-end gap-2">
        <label className="grid gap-1 text-xs">
          {lbl(p.labels, "builder.key")}
          <Input className="h-8 w-32 font-mono" value={o.key} onChange={(e) => onChange({ ...o, key: e.target.value })} />
        </label>
        <label className="grid gap-1 text-xs">
          {lbl(p.labels, "scoring.priority")}
          <Input type="number" className="h-8 w-20" value={o.priority} onChange={(e) => onChange({ ...o, priority: Number(e.target.value) })} />
        </label>
        <label className="grid gap-1 text-xs">
          {lbl(p.labels, "scoring.ending")}
          <select className={selectClass} value={o.endingKey} onChange={(e) => onChange({ ...o, endingKey: e.target.value })}>
            {endings.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-xs">
          {lbl(p.labels, "scoring.tags")}
          <Input className="h-8 w-56 font-mono" value={o.tagKeys.join(", ")} onChange={(e) => onChange({ ...o, tagKeys: e.target.value.split(",").map((t) => t.trim()).filter(Boolean) })} />
        </label>
        <Button type="button" variant="ghost" size="sm" onClick={onRemove}>
          {lbl(p.labels, "builder.remove")}
        </Button>
      </div>
      <LocalizedInput name={`outcome-${o.key}-label`} value={o.label} locales={p.locales} labels={tl("scoring.outcome_label")} onChange={(label) => onChange({ ...o, label: label })} />
      <ConditionBuilder legend={lbl(p.labels, "scoring.when")} value={o.when} onChange={(when) => onChange({ ...o, when: when ?? { all: [] } })} fields={fields} dimensions={dims} labels={p.labels} />
      <LocalizedInput name={`outcome-${o.key}-explanation`} multiline value={o.explanation ?? {}} locales={p.locales} labels={tl("scoring.explanation")} onChange={(v) => onChange({ ...o, explanation: v })} />
      <LocalizedInput name={`outcome-${o.key}-recommendation`} multiline value={o.recommendation ?? {}} locales={p.locales} labels={tl("scoring.recommendation")} onChange={(v) => onChange({ ...o, recommendation: v })} />
    </section>
  );
}

export type ScoringEditorProps = { draft: DraftInput; kind: FormKind; labels: Labels; locale: Locale; localeNames: Record<Locale, string> };

export function ScoringEditor({ draft, kind, labels, locale, localeNames }: ScoringEditorProps) {
  const s = useDraft(draft, kind, labels);
  const sc = s.scoring;
  const p: P = { labels, locales: s.locales, localeNames };
  const [started, setStarted] = useState(sc.dimensions.length > 0);
  const set = (patch: Partial<FormScoring>) => s.setScoring({ ...sc, ...patch });
  const def: FormDefinition = s.definition;
  // S7 / L6: outcome conditions may not use sensitive fields.
  const fields: ConditionFieldRef[] = Object.values(def.fields)
    .filter((f: Field) => !f.sensitive)
    .map((f) => ({ key: f.key, label: f.label[locale] ?? f.key, type: f.type, ...("options" in f ? { options: f.options.map((o) => ({ key: o.key, label: o.label[locale] ?? o.key })) } : {}) }));
  const dims: ConditionDimensionRef[] = sc.dimensions.map((d) => ({ key: d.key, label: d.label[locale] ?? d.key, ranges: d.ranges.map((r) => ({ key: r.key, label: r.label[locale] ?? r.key })) }));
  const addDimension = () => {
    setStarted(true);
    set({ dimensions: [...sc.dimensions, { key: nextKey("dim", sc.dimensions.map((d) => d.key)), label: {}, kind: "sum", ranges: [] }] });
  };
  const outcomes = [...sc.outcomes].sort((a, b) => a.priority - b.priority);
  const setOutcome = (key: string, o: Outcome | null) => set({ outcomes: o ? sc.outcomes.map((x) => (x.key === key ? o : x)) : sc.outcomes.filter((x) => x.key !== key) });
  const scoringIssues = s.issues.filter((i) => i.path.startsWith("scoring") || ["formula_invalid", "dimension_cycle", "range_overlap", "range_invalid", "default_outcome_missing", "outcome_unselectable"].includes(i.code));

  return (
    <div className="grid gap-6">
      <div className="flex items-center justify-end gap-3">
        <SaveIndicator status={s.status} labels={labels} />
        <Button type="button" variant="outline" onClick={() => void s.save()} disabled={s.status === "saving" || s.status === "conflict"}>
          {lbl(labels, "builder.save_now")}
        </Button>
      </div>
      <ConflictDialog open={s.status === "conflict"} labels={labels} />
      {!started && !sc.dimensions.length ? (
        <EmptyState
          title={lbl(labels, "scoring.empty")}
          action={
            <Button type="button" onClick={addDimension}>
              {lbl(labels, "scoring.add_dimension")}
            </Button>
          }
        />
      ) : (
        <>
          <section className="grid gap-3" aria-label={lbl(labels, "scoring.dimensions")}>
            <h2 className="text-lg font-semibold">{lbl(labels, "scoring.dimensions")}</h2>
            {sc.dimensions.map((d, i) => (
              <DimensionEditor key={i} d={d} p={p} onChange={(next) => set({ dimensions: sc.dimensions.map((x, j) => (j === i ? next : x)) })} onRemove={() => set({ dimensions: sc.dimensions.filter((_, j) => j !== i) })} />
            ))}
            <div>
              <Button type="button" variant="outline" onClick={addDimension}>
                {lbl(labels, "scoring.add_dimension")}
              </Button>
            </div>
          </section>
          <section className="grid gap-3" aria-label={lbl(labels, "scoring.total")}>
            <h2 className="text-lg font-semibold">{lbl(labels, "scoring.total")}</h2>
            <label className="grid gap-1 text-sm">
              {lbl(labels, "scoring.total_kind")}
              <select
                className={selectClass}
                value={sc.total?.kind ?? ""}
                onChange={(e) => {
                  const v = e.target.value;
                  if (!v) {
                    const { total: _t, ...rest } = sc;
                    s.setScoring(rest);
                  } else set({ total: { kind: v as "sum_dimensions" | "formula", ranges: sc.total?.ranges ?? [], ...(sc.total?.formula ? { formula: sc.total.formula } : {}) } });
                }}
              >
                <option value="">{lbl(labels, "scoring.total_none")}</option>
                <option value="sum_dimensions">{lbl(labels, "scoring.total_sum")}</option>
                <option value="formula">{lbl(labels, "scoring.kind_formula")}</option>
              </select>
            </label>
            {sc.total?.kind === "formula" ? <FormulaInput label={lbl(labels, "scoring.formula")} value={sc.total.formula ?? ""} onChange={(formula) => set({ total: { ...sc.total!, formula } })} labels={labels} /> : null}
            {sc.total ? <Ranges ranges={sc.total.ranges} onChange={(ranges) => set({ total: { ...sc.total!, ranges } })} p={p} /> : null}
          </section>
          <section className="grid gap-3" aria-label={lbl(labels, "scoring.outcomes")}>
            <h2 className="text-lg font-semibold">{lbl(labels, "scoring.outcomes")}</h2>
            <p className="text-sm text-muted-foreground">{lbl(labels, "scoring.outcomes_visible")}</p>
            {outcomes.map((o) => (
              <OutcomeEditor key={o.key} o={o} p={p} endings={def.endings.map((e) => e.key)} fields={fields} dims={dims} onChange={(next) => setOutcome(o.key, next)} onRemove={() => setOutcome(o.key, null)} />
            ))}
            <div className="flex flex-wrap items-end gap-3">
              <Button
                type="button"
                variant="outline"
                onClick={() => set({ outcomes: [...sc.outcomes, { key: nextKey("outcome", sc.outcomes.map((o) => o.key)), label: {}, priority: (outcomes.at(-1)?.priority ?? 0) + 10, when: { all: [] }, endingKey: def.endings[0]?.key ?? "", tagKeys: [] }] })}
              >
                {lbl(labels, "scoring.add_outcome")}
              </Button>
              {sc.outcomes.length ? (
                <label className="grid gap-1 text-sm">
                  {lbl(labels, "scoring.default_outcome")}
                  <select
                    className={selectClass}
                    value={sc.defaultOutcomeKey ?? ""}
                    onChange={(e) => {
                      const { defaultOutcomeKey: _d, ...rest } = sc;
                      s.setScoring(e.target.value ? { ...rest, defaultOutcomeKey: e.target.value } : rest);
                    }}
                  >
                    <option value="">—</option>
                    {sc.outcomes.map((o) => (
                      <option key={o.key} value={o.key}>
                        {o.label[locale] || o.key}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
            </div>
          </section>
        </>
      )}
      <IssuesPanel issues={scoringIssues} labels={labels} />
    </div>
  );
}
