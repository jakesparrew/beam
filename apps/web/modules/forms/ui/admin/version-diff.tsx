"use client";

/**
 * Version comparison (forms spec section 5 `/admin/forms/[formId]/versions`; forms-P5): what was
 * added, removed and changed between two versions, by field, section, logic, ending and scoring
 * (`service/diff.ts`). Only keys and property names are shown, never content values.
 */
import type { KeyedDiff, VersionDiff as Diff } from "../../service/diff";
import { lbl, type Labels } from "./issues-panel";

function Group({ title, diff, labels, extra }: { title: string; diff: KeyedDiff; labels: Labels; extra?: string[] }) {
  if (!diff.added.length && !diff.removed.length && !diff.changed.length && !extra?.length) return null;
  return (
    <section className="grid gap-1" aria-label={title}>
      <h3 className="font-medium">{title}</h3>
      <ul className="grid gap-1 text-sm">
        {diff.added.map((k) => (
          <li key={`a:${k}`} data-diff="added">
            <span className="mr-2 rounded bg-success/10 px-1 text-xs">{lbl(labels, "versions.added")}</span>
            <code>{k}</code>
          </li>
        ))}
        {diff.removed.map((k) => (
          <li key={`r:${k}`} data-diff="removed">
            <span className="mr-2 rounded bg-destructive/10 px-1 text-xs">{lbl(labels, "versions.removed")}</span>
            <code>{k}</code>
          </li>
        ))}
        {diff.changed.map((c) => (
          <li key={`c:${c.key}`} data-diff="changed">
            <span className="mr-2 rounded bg-warning/15 px-1 text-xs">{lbl(labels, "versions.changed")}</span>
            <code>{c.key}</code>: {c.props.join(", ")}
          </li>
        ))}
        {(extra ?? []).map((x) => (
          <li key={`x:${x}`}>{x}</li>
        ))}
      </ul>
    </section>
  );
}

export function VersionDiff({ diff, labels }: { diff: Diff; labels: Labels }) {
  const title = lbl(labels, "versions.compare_title", { from: diff.from.version, to: diff.to.version });
  if (diff.same) {
    return (
      <section aria-label={title} className="grid gap-2">
        <h2 className="text-lg font-semibold">{title}</h2>
        <p className="text-sm text-muted-foreground">{lbl(labels, "versions.same")}</p>
      </section>
    );
  }
  const form = [
    ...diff.form.map((p) => lbl(labels, "versions.form_changed", { prop: p })),
    ...diff.locales.added.map((l) => lbl(labels, "versions.locale_added", { locale: l })),
    ...diff.locales.removed.map((l) => lbl(labels, "versions.locale_removed", { locale: l })),
  ];
  const s = diff.scoring;
  const scoringExtra = [...s.total.map((p) => lbl(labels, "versions.total_changed", { prop: p })), ...(s.defaultOutcome ? [lbl(labels, "versions.default_outcome_changed")] : [])];
  return (
    <section aria-label={title} className="grid gap-4">
      <h2 className="text-lg font-semibold">{title}</h2>
      {form.length ? (
        <ul className="grid gap-1 text-sm">
          {form.map((x) => (
            <li key={x}>{x}</li>
          ))}
        </ul>
      ) : null}
      <Group title={lbl(labels, "versions.sections")} diff={diff.sections} labels={labels} extra={diff.sections.moved.length ? [lbl(labels, "versions.moved", { keys: diff.sections.moved.join(", ") })] : []} />
      <Group title={lbl(labels, "versions.fields")} diff={diff.fields} labels={labels} />
      <Group title={lbl(labels, "versions.logic")} diff={diff.logic} labels={labels} />
      <Group title={lbl(labels, "versions.endings")} diff={diff.endings} labels={labels} />
      <Group title={lbl(labels, "versions.dimensions")} diff={s.dimensions} labels={labels} extra={scoringExtra} />
      <Group title={lbl(labels, "versions.outcomes")} diff={s.outcomes} labels={labels} />
    </section>
  );
}
