/**
 * Submissions list (forms spec section 5 `/admin/forms/[formId]/submissions`; forms-P6): filters
 * (status, outcome, version, source, funnel, dates, person search) as a GET form, the table
 * (started, completed, status, person, outcome, total, version, source, campaign, funnel, entered
 * by) and keyset paging. Renders on the server: no state, no client hooks. Also the server-safe
 * label helper of the forms-P6 screens.
 */
import Link from "next/link";
import { formatDateTime, formatNumber, type Locale } from "@beam/core/i18n";
import { Badge, Button, EmptyState, Input, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@beam/ui";
import type { SubmissionFilter, SubmissionFilterOptions, SubmissionRow } from "../../queries";

/** Screen copy keyed relative to `forms.`; a missing key renders `⟦forms.<key>⟧`. */
export type Labels = Readonly<Record<string, string>>;

/**
 * The label `key` with `{name}` placeholders filled. A server-safe twin of `issues-panel`'s
 * `lbl` (that file is a client module, so its functions cannot run in a server component).
 */
export function lbl(labels: Labels, key: string, params?: Record<string, string | number>): string {
  const raw = labels[key];
  if (raw === undefined) return `⟦forms.${key}⟧`;
  return params ? raw.replace(/\{(\w+)\}/g, (m, k: string) => (params[k] !== undefined ? String(params[k]) : m)) : raw;
}

const STATUSES = ["started", "partial", "abandoned", "completed"] as const;
const selectClass = "h-9 rounded-md border bg-background px-2 text-sm";

export type SubmissionTableProps = {
  formId: string;
  rows: SubmissionRow[];
  nextCursor: string | null;
  filter: Omit<SubmissionFilter, "formId">;
  options: SubmissionFilterOptions;
  outcomeLabels: Record<string, string>;
  locale: Locale;
  labels: Labels;
};

/** The query string of the current filter (without the cursor), for paging and the CSV link. */
export function filterQuery(filter: Omit<SubmissionFilter, "formId">, extra: Record<string, string> = {}): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...filter, cursor: undefined, ...extra })) if (typeof v === "string" && v) p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : "";
}

function Select({ name, value, label, options }: { name: string; value: string | undefined; label: string; options: { value: string; label: string }[] }) {
  return (
    <label className="grid gap-1 text-sm">
      {label}
      <select name={name} defaultValue={value ?? ""} className={selectClass}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function SubmissionTable({ formId, rows, nextCursor, filter, options, outcomeLabels, locale, labels }: SubmissionTableProps) {
  const all = { value: "", label: lbl(labels, "submissions.all") };
  const base = `/admin/forms/${formId}/submissions`;
  const filtered = Object.values(filter).some((v) => typeof v === "string" && v);
  return (
    <div className="grid gap-4">
      <form method="get" action={base} className="flex flex-wrap items-end gap-3 rounded-md border p-3" aria-label={lbl(labels, "submissions.filters")}>
        <Select name="status" value={filter.status} label={lbl(labels, "submissions.filter_status")} options={[all, ...STATUSES.map((s) => ({ value: s, label: lbl(labels, `submissions.status_${s}`) }))]} />
        {options.outcomes.length ? (
          <Select name="outcomeKey" value={filter.outcomeKey} label={lbl(labels, "submissions.filter_outcome")} options={[all, ...options.outcomes.map((o) => ({ value: o.key, label: outcomeLabels[o.key] ?? o.key }))]} />
        ) : null}
        <Select
          name="versionId"
          value={filter.versionId}
          label={lbl(labels, "submissions.filter_version")}
          options={[all, ...options.versions.map((v) => ({ value: v.id, label: lbl(labels, "submissions.version_n", { n: v.version }) }))]}
        />
        <Select name="source" value={filter.source} label={lbl(labels, "submissions.filter_source")} options={[all, ...options.sources.map((s) => ({ value: s, label: s }))]} />
        <Select name="funnel" value={filter.funnel} label={lbl(labels, "submissions.filter_funnel")} options={[all, ...options.funnels.map((s) => ({ value: s, label: s }))]} />
        <label className="grid gap-1 text-sm">
          {lbl(labels, "submissions.filter_from")}
          <Input type="date" name="from" defaultValue={filter.from ?? ""} className="w-40" />
        </label>
        <label className="grid gap-1 text-sm">
          {lbl(labels, "submissions.filter_to")}
          <Input type="date" name="to" defaultValue={filter.to ?? ""} className="w-40" />
        </label>
        <label className="grid gap-1 text-sm">
          {lbl(labels, "submissions.filter_q")}
          <Input type="search" name="q" defaultValue={filter.q ?? ""} maxLength={100} className="w-56" />
        </label>
        <Button type="submit">{lbl(labels, "submissions.apply")}</Button>
        {filtered ? (
          <Link className="text-sm underline" href={base as never}>
            {lbl(labels, "submissions.reset")}
          </Link>
        ) : null}
      </form>

      {rows.length === 0 ? (
        <EmptyState title={lbl(labels, filtered ? "list.no_match" : "submissions.empty")} />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{lbl(labels, "submissions.col_started")}</TableHead>
              <TableHead>{lbl(labels, "submissions.col_completed")}</TableHead>
              <TableHead>{lbl(labels, "submissions.col_status")}</TableHead>
              <TableHead>{lbl(labels, "submissions.col_person")}</TableHead>
              <TableHead>{lbl(labels, "submissions.col_outcome")}</TableHead>
              <TableHead className="text-right">{lbl(labels, "submissions.col_total")}</TableHead>
              <TableHead>{lbl(labels, "submissions.col_version")}</TableHead>
              <TableHead>{lbl(labels, "submissions.col_source")}</TableHead>
              <TableHead>{lbl(labels, "submissions.col_campaign")}</TableHead>
              <TableHead>{lbl(labels, "submissions.col_funnel")}</TableHead>
              <TableHead>{lbl(labels, "submissions.col_entered_by")}</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.id} data-status={r.status}>
                <TableCell className="whitespace-nowrap">{formatDateTime(r.startedAt, locale, "short")}</TableCell>
                <TableCell className="whitespace-nowrap">{r.completedAt ? formatDateTime(r.completedAt, locale, "short") : "—"}</TableCell>
                <TableCell>
                  <Badge variant={r.status === "completed" ? "default" : r.status === "abandoned" ? "outline" : "secondary"}>{lbl(labels, `submissions.status_${r.status}`)}</Badge>
                </TableCell>
                <TableCell>
                  {!r.person ? (
                    <span className="text-muted-foreground">{lbl(labels, "submissions.anonymous")}</span>
                  ) : r.person.erased ? (
                    <span className="text-muted-foreground">{lbl(labels, "submissions.erased")}</span>
                  ) : (
                    <Link className="underline" href={`/admin/persons/${r.person.id}` as never}>
                      {r.person.name ?? r.person.email ?? r.person.id.slice(0, 8)}
                    </Link>
                  )}
                </TableCell>
                <TableCell>{r.outcomeKey ? (outcomeLabels[r.outcomeKey] ?? r.outcomeKey) : "—"}</TableCell>
                <TableCell className="text-right tabular-nums">{r.total !== null ? formatNumber(r.total, locale) : "—"}</TableCell>
                <TableCell>{lbl(labels, "submissions.version_n", { n: r.version })}</TableCell>
                <TableCell>{r.source}</TableCell>
                <TableCell>{r.campaign ?? "—"}</TableCell>
                <TableCell>{r.funnel}</TableCell>
                <TableCell>{r.enteredByName ?? "—"}</TableCell>
                <TableCell>
                  <Link className="underline" href={`${base}/${r.id}` as never}>
                    {lbl(labels, "submissions.open")}
                  </Link>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <nav className="flex gap-4 text-sm" aria-label={lbl(labels, "list.pagination")}>
        {filter.cursor ? (
          <Link className="underline" href={`${base}${filterQuery(filter)}` as never}>
            {lbl(labels, "submissions.first_page")}
          </Link>
        ) : null}
        {nextCursor ? (
          <Link className="underline" href={`${base}${filterQuery(filter, { cursor: nextCursor })}` as never}>
            {lbl(labels, "submissions.next_page")}
          </Link>
        ) : null}
      </nav>
    </div>
  );
}
