"use client";

/**
 * Formula input (rule S3; forms-P5): the safe expression language with a live syntax check (the
 * same `parseExpression` the server runs, no `eval`) and a tester that evaluates the formula with
 * sample values for every `dim.<key>`, `answer.<key>` and `total` it references.
 */
import { useId, useMemo, useState } from "react";
import { EXPRESSION_MAX_LENGTH, evaluate, expressionRefs, parseExpression } from "@beam/core/forms";
import { Input } from "@beam/ui";
import { lbl, type Labels } from "./issues-panel";

export type FormulaInputProps = {
  value: string;
  onChange: (v: string) => void;
  label: string;
  labels: Labels;
};

export function FormulaInput({ value, onChange, label, labels }: FormulaInputProps) {
  const id = useId();
  const parsed = useMemo(() => (value.trim() ? parseExpression(value) : null), [value]);
  const refs = useMemo(() => (parsed?.ok ? expressionRefs(parsed.ast) : { dims: [], answers: [], total: false }), [parsed]);
  const [samples, setSamples] = useState<Record<string, string>>({});
  const names = [...refs.dims.map((k) => `dim.${k}`), ...refs.answers.map((k) => `answer.${k}`), ...(refs.total ? ["total"] : [])];
  const result = useMemo(() => {
    if (!parsed?.ok) return undefined;
    const n = (k: string) => (samples[k] === undefined || samples[k] === "" ? null : Number(samples[k]));
    return evaluate(parsed.ast, {
      dims: Object.fromEntries(refs.dims.map((k) => [k, n(`dim.${k}`)])),
      answers: Object.fromEntries(refs.answers.map((k) => [k, n(`answer.${k}`)])),
      total: n("total"),
    });
  }, [parsed, refs, samples]);
  return (
    <div className="grid gap-2">
      <label htmlFor={id} className="text-sm">
        {label}
      </label>
      <Input
        id={id}
        className="font-mono"
        value={value}
        maxLength={EXPRESSION_MAX_LENGTH}
        aria-invalid={parsed && !parsed.ok ? true : undefined}
        aria-describedby={`${id}-check`}
        onChange={(e) => onChange(e.target.value)}
      />
      <p id={`${id}-check`} role="status" className={`text-xs ${parsed && !parsed.ok ? "text-destructive" : "text-muted-foreground"}`}>
        {!parsed ? lbl(labels, "scoring.formula_empty") : parsed.ok ? lbl(labels, "scoring.formula_ok") : lbl(labels, "scoring.formula_error", { pos: parsed.error.pos + 1, message: parsed.error.message })}
      </p>
      {parsed?.ok && names.length ? (
        <fieldset className="grid gap-2 rounded-md border p-2">
          <legend className="text-xs font-medium">{lbl(labels, "scoring.tester")}</legend>
          <div className="flex flex-wrap gap-2">
            {names.map((k) => (
              <label key={k} className="flex items-center gap-1 text-xs">
                <span className="font-mono">{k}</span>
                <Input type="number" className="h-8 w-20" value={samples[k] ?? ""} onChange={(e) => setSamples({ ...samples, [k]: e.target.value })} />
              </label>
            ))}
          </div>
          <p className="text-sm" aria-live="polite">
            {lbl(labels, "scoring.tester_result", { value: result === null || result === undefined ? "null" : String(result) })}
          </p>
        </fieldset>
      ) : null}
    </div>
  );
}
