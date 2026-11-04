"use client";

/**
 * The builder's issue list (forms spec section 5 `/build`, rules P1 and P8; forms-P5): blocking
 * errors and warnings from `validateForPublish`, each linking to its path, and the completeness
 * badge per locale (P2). Also the label helper every admin builder component uses: copy comes from
 * the server as a flat map of `forms.*` keys, and a missing key renders `⟦forms.<key>⟧`.
 */
import type { PublishIssue } from "@beam/core/forms";
import type { Locale } from "@beam/core/i18n";
import { Badge } from "@beam/ui";

/** Screen copy, keyed relative to `forms.` (for example `builder.save`). */
export type Labels = Readonly<Record<string, string>>;

/** The label `key` with `{name}` placeholders filled; `⟦forms.<key>⟧` when the copy is missing. */
export function lbl(labels: Labels, key: string, params?: Record<string, string | number>): string {
  const raw = labels[key];
  if (raw === undefined) return `⟦forms.${key}⟧`;
  return params ? raw.replace(/\{(\w+)\}/g, (m, k: string) => (params[k] !== undefined ? String(params[k]) : m)) : raw;
}

/** Locales with at least one `incomplete_text` issue, with their count. */
export function missingByLocale(issues: readonly PublishIssue[], locales: readonly Locale[]): Record<string, number> {
  const out: Record<string, number> = Object.fromEntries(locales.map((l) => [l, 0]));
  for (const i of issues) if (i.code === "incomplete_text") for (const l of i.locales ?? []) out[l] = (out[l] ?? 0) + 1;
  return out;
}

export function CompletenessBadges({ issues, locales, labels }: { issues: readonly PublishIssue[]; locales: readonly Locale[]; labels: Labels }) {
  const missing = missingByLocale(issues, locales);
  return (
    <ul className="flex flex-wrap gap-2" aria-label={lbl(labels, "builder.completeness")}>
      {locales.map((l) => (
        <li key={l}>
          <Badge variant={missing[l] ? "destructive" : "secondary"}>
            {l}: {missing[l] ? lbl(labels, "builder.missing_count", { n: missing[l] }) : lbl(labels, "builder.complete")}
          </Badge>
        </li>
      ))}
    </ul>
  );
}

export type IssuesPanelProps = {
  issues: readonly PublishIssue[];
  labels: Labels;
  /** Called with an issue's path (for example `fields.email.label`) to select it in the builder. */
  onSelect?: (path: string) => void;
  /** Base href for issue links when there is no `onSelect` (the preview's "invalid draft" list). */
  builderHref?: string;
};

function issueText(labels: Labels, i: PublishIssue): string {
  const key = `builder.issue.${i.code}`;
  const text = labels[key] !== undefined ? lbl(labels, key) : i.message;
  return i.locales?.length ? `${text} (${i.locales.join(", ")})` : text;
}

/** Errors first, then warnings; empty: "Ready to publish". */
export function IssuesPanel({ issues, labels, onSelect, builderHref }: IssuesPanelProps) {
  const errors = issues.filter((i) => i.level === "error");
  const warnings = issues.filter((i) => i.level === "warning");
  if (!issues.length) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        {lbl(labels, "builder.no_issues")}
      </p>
    );
  }
  const item = (i: PublishIssue, n: number) => (
    <li key={`${i.code}:${i.path}:${n}`} className="text-sm">
      {onSelect ? (
        <button type="button" className="text-left underline-offset-2 hover:underline" onClick={() => onSelect(i.path)}>
          {issueText(labels, i)}
        </button>
      ) : builderHref ? (
        <a className="underline-offset-2 hover:underline" href={`${builderHref}?focus=${encodeURIComponent(i.path)}`}>
          {issueText(labels, i)}
        </a>
      ) : (
        issueText(labels, i)
      )}
      {i.path ? <span className="ml-2 font-mono text-xs text-muted-foreground">{i.path}</span> : null}
    </li>
  );
  return (
    <section aria-label={lbl(labels, "builder.issues")} className="grid gap-3">
      {errors.length ? (
        <div>
          <h3 className="text-sm font-medium text-destructive">{lbl(labels, "builder.errors", { n: errors.length })}</h3>
          <ul className="mt-1 grid gap-1">{errors.map(item)}</ul>
        </div>
      ) : null}
      {warnings.length ? (
        <div>
          <h3 className="text-sm font-medium">{lbl(labels, "builder.warnings", { n: warnings.length })}</h3>
          <ul className="mt-1 grid gap-1">{warnings.map(item)}</ul>
        </div>
      ) : null}
    </section>
  );
}
