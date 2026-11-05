"use client";

/**
 * Preview (forms spec section 5 `/admin/forms/[formId]/preview`; forms-P5): the public field inputs
 * of the hosted page (`ui/public/field-inputs.tsx`) driven by the same pure engine the server runs
 * (`nextStep`, `validateSection`, `computeScore`, `selectOutcome`, L5), with no request at all:
 * "Preview, nothing is saved". The side panel shows the visited path, live scores (sensitive ones
 * too: they stay in this browser), the matched outcome and the ending. Restart and jump to a
 * section are offered.
 */
import { useMemo, useState } from "react";
import { computePath, computeScore, isVisible, nextStep, selectOutcome, validateSection, type AnswerValue, type Answers, type FormDefinition, type FormScoring } from "@beam/core/forms";
import type { Locale } from "@beam/core/i18n";
import { Button } from "@beam/ui";
import { errorText, FieldInput, Markdown, type PublicLabels } from "../public/field-inputs";
import { lbl, type Labels } from "./issues-panel";

export type PreviewFrameProps = {
  definition: FormDefinition;
  scoring: FormScoring;
  locale: Locale;
  labels: Labels;
  publicLabels: PublicLabels;
  /** Version shown in the bar ("Draft" or "Version n"). */
  versionLabel: string;
};

const pick = (t: Partial<Record<Locale, string>> | undefined, l: Locale) => (t ? (t[l] ?? "") : "");

export function PreviewFrame({ definition: def, scoring, locale, labels, publicLabels, versionLabel }: PreviewFrameProps) {
  const first = def.sections[0]?.key ?? null;
  const [answers, setAnswers] = useState<Answers>({});
  const [path, setPath] = useState<string[]>(first ? [first] : []);
  const [ending, setEnding] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const current = ending ? null : (path.at(-1) ?? null);
  const section = def.sections.find((s) => s.key === current);
  const score = useMemo(() => computeScore(def, scoring, answers), [def, scoring, answers]);
  const outcome = useMemo(() => selectOutcome(scoring, answers, score), [scoring, answers, score]);
  const predicted = useMemo(() => computePath(def, scoring, answers), [def, scoring, answers]);

  const restart = () => {
    setAnswers({});
    setPath(first ? [first] : []);
    setEnding(null);
    setErrors({});
  };
  const jump = (key: string) => {
    const i = path.indexOf(key);
    setPath(i >= 0 ? path.slice(0, i + 1) : [...path, key]);
    setEnding(null);
    setErrors({});
  };
  const next = () => {
    if (!current) return;
    const v = validateSection(def, path, current, answers, scoring);
    if (!v.ok) {
      setErrors(v.fields);
      return;
    }
    setErrors({});
    const step = nextStep(def, scoring, answers, current);
    if ("section" in step) setPath([...path, step.section]);
    else setEnding(step.end ?? predicted.endingKey ?? def.endings[0]?.key ?? null);
  };
  const back = () => {
    if (ending) setEnding(null);
    else if (path.length > 1) setPath(path.slice(0, -1));
  };
  const end = def.endings.find((e) => e.key === ending);
  const set = (key: string, value: AnswerValue | undefined) => {
    const nextAnswers = { ...answers };
    if (value === undefined) delete nextAnswers[key];
    else nextAnswers[key] = value;
    setAnswers(nextAnswers);
  };
  const scores = { answers, scores: score };

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="overflow-hidden rounded-lg border" data-preview-frame>
        <div role="note" className="bg-warning/15 px-4 py-2 text-sm font-medium">
          {lbl(labels, "preview.bar", { version: versionLabel })}
        </div>
        <div lang={locale} className="grid gap-4 p-4">
          <h2 className="text-xl font-semibold">{pick(def.title, locale)}</h2>
          {end ? (
            <section className="grid gap-2" aria-live="polite">
              <h3 className="text-lg font-semibold">{pick(end.title, locale)}</h3>
              <Markdown text={pick(end.body, locale)} />
              {end.showScore && score.total !== null ? <p>{lbl(labels, "preview.total", { value: score.total })}</p> : null}
              {end.ctas.length ? (
                <ul className="flex flex-wrap gap-2">
                  {end.ctas.map((c) => (
                    <li key={c.key}>
                      <span className="inline-flex rounded-md border px-3 py-2 text-sm">{pick(c.label, locale)}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </section>
          ) : section ? (
            <section className="grid gap-4">
              {def.settings.showProgress ? <p className="text-sm text-muted-foreground">{(publicLabels.progress ?? "{n}/{total}").replace("{n}", String(path.length)).replace("{total}", String(Math.max(predicted.path.length, path.length)))}</p> : null}
              {section.title ? <h3 className="text-lg font-semibold">{pick(section.title, locale)}</h3> : null}
              {section.description ? <Markdown text={pick(section.description, locale)} /> : null}
              {section.fieldKeys.map((k) => {
                const f = def.fields[k];
                if (!f || f.type === "hidden" || f.type === "utm" || !isVisible(f, scores)) return null;
                return <FieldInput key={k} field={f} value={answers[k]} onChange={(v) => set(k, v)} locale={locale} labels={publicLabels} error={errors[k]} idPrefix="preview" />;
              })}
              {Object.keys(errors).length ? (
                <ul role="alert" className="text-sm text-destructive">
                  {Object.entries(errors).map(([k, code]) => (
                    <li key={k}>
                      {pick(def.fields[k]?.label, locale) || k}: {errorText(code, publicLabels)}
                    </li>
                  ))}
                </ul>
              ) : null}
            </section>
          ) : (
            <p>{lbl(labels, "preview.no_sections")}</p>
          )}
          <div className="flex gap-2">
            <Button type="button" variant="outline" onClick={back} disabled={!ending && path.length <= 1}>
              {publicLabels.back ?? "Back"}
            </Button>
            {!ending && section ? (
              <Button type="button" onClick={next}>
                {publicLabels.next ?? "Next"}
              </Button>
            ) : null}
          </div>
        </div>
      </div>
      <aside className="grid content-start gap-4 text-sm" aria-label={lbl(labels, "preview.panel")}>
        <div className="flex gap-2">
          <Button type="button" variant="outline" size="sm" onClick={restart}>
            {lbl(labels, "preview.restart")}
          </Button>
          <label className="flex items-center gap-1">
            <span className="sr-only">{lbl(labels, "preview.jump")}</span>
            <select className="h-8 rounded-md border bg-background px-2" value="" onChange={(e) => e.target.value && jump(e.target.value)} aria-label={lbl(labels, "preview.jump")}>
              <option value="">{lbl(labels, "preview.jump")}</option>
              {def.sections.map((s, i) => (
                <option key={s.key} value={s.key}>
                  {pick(s.title, locale) || `${i + 1}. ${s.key}`}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div>
          <h3 className="font-medium">{lbl(labels, "preview.path")}</h3>
          <ol className="list-decimal pl-5" data-preview-path>
            {path.map((k) => (
              <li key={k}>{k}</li>
            ))}
          </ol>
        </div>
        <div>
          <h3 className="font-medium">{lbl(labels, "preview.scores")}</h3>
          <ul data-preview-scores>
            <li>
              {lbl(labels, "scoring.total")}: {score.total ?? "–"} {score.totalRangeKey ? `(${score.totalRangeKey})` : ""}
            </li>
            {Object.entries(score.dimensions).map(([k, v]) => (
              <li key={k}>
                {k}: {v.value ?? "–"} {v.rangeKey ? `(${v.rangeKey})` : ""}
                {score.sensitiveDimensionKeys.includes(k) ? ` · ${lbl(labels, "builder.sensitive_badge")}` : ""}
              </li>
            ))}
          </ul>
        </div>
        <p>
          <span className="font-medium">{lbl(labels, "preview.outcome")}</span> <span data-preview-outcome>{outcome ? pick(outcome.label, locale) || outcome.key : "–"}</span>
        </p>
        <p>
          <span className="font-medium">{lbl(labels, "preview.ending")}</span> <span data-preview-ending>{ending ?? predicted.endingKey ?? "–"}</span>
        </p>
      </aside>
    </div>
  );
}
