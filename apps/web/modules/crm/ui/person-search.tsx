"use client";
/**
 * `/admin/persons` list (crm spec 5.1): search box (customer number, email, phone, name), filters
 * (status, tag, segment, locale, acquisition source, tester), the columns of the spec, row
 * selection with bulk tag and untag (at most 5000), and the empty state. Filters live in the URL
 * (a GET form); the page is numbered (`page`). Every string is a prop.
 */
import Link from "next/link";
import { useState } from "react";
import { Badge, Checkbox, DataTable, EmptyState, type DataTableColumn, type DataTableFilter } from "@beam/ui";
import type { PersonStatus } from "@beam/core/crm";
import { StatusBadge, type StatusBadgeLabels } from "./status-badge";
import { TagPicker, type TagOption, type TagPickerLabels } from "./tag-picker";

export type PersonRowView = {
  id: string;
  customerNumber: string;
  name: string;
  email: string | null;
  status: PersonStatus;
  isOverridden: boolean;
  isMember: boolean;
  tags: string[];
  lastActivityAt: string | null;
  createdAt: string;
};

export type FilterOption = { value: string; label: string };

export type PersonsTableLabels = {
  searchPlaceholder: string;
  search: string;
  filterStatus: string;
  filterTag: string;
  filterSegment: string;
  filterLocale: string;
  filterSource: string;
  filterTester: string;
  all: string;
  yes: string;
  no: string;
  columns: Record<"select" | "number" | "name" | "email" | "status" | "member" | "tags" | "lastActivity" | "created", string>;
  /** `crm.persons.list.selected` rendered for 1 and for 7 (the client swaps in the real count). */
  selectedOne: string;
  selectedOther: string;
  selectAll: string;
  empty: string;
  emptyFiltered: string;
  emptyCreate: string;
  emptyImport: string;
  pageOf: string;
  previous: string;
  next: string;
  pagination: string;
  applyFilters: string;
  filters: string;
  status: StatusBadgeLabels;
  picker: TagPickerLabels;
};

export function PersonsTable({
  rows,
  total,
  page,
  pageSize,
  searchParams,
  options,
  tags,
  canWrite,
  locale,
  labels,
}: {
  rows: PersonRowView[];
  total: number;
  page: number;
  pageSize: number;
  searchParams: Record<string, string | undefined>;
  options: { statuses: FilterOption[]; tags: FilterOption[]; segments: FilterOption[]; locales: FilterOption[]; sources: FilterOption[] };
  tags: TagOption[];
  canWrite: boolean;
  locale: string;
  labels: PersonsTableLabels;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const date = new Intl.DateTimeFormat(locale, { dateStyle: "short", timeZone: "Europe/Brussels" });
  const tagLabel = new Map(tags.map((t) => [t.key, t]));
  const toggle = (id: string, on: boolean) =>
    setSelected((s) => {
      const next = new Set(s);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  const allOnPage = rows.length > 0 && rows.every((r) => selected.has(r.id));

  const columns: DataTableColumn<PersonRowView>[] = [
    ...(canWrite
      ? [
          {
            key: "select",
            header: (
              <Checkbox
                aria-label={labels.selectAll}
                checked={allOnPage}
                onCheckedChange={(v) => setSelected((s) => new Set(v === true ? [...s, ...rows.map((r) => r.id)] : [...s].filter((id) => !rows.some((r) => r.id === id))))}
              />
            ),
            cell: (r: PersonRowView) => <Checkbox aria-label={`${labels.columns.select} ${r.name}`} checked={selected.has(r.id)} onCheckedChange={(v) => toggle(r.id, v === true)} />,
          } satisfies DataTableColumn<PersonRowView>,
        ]
      : []),
    { key: "number", header: labels.columns.number, className: "font-mono text-xs", cell: (r) => r.customerNumber },
    { key: "name", header: labels.columns.name, cell: (r) => <Link href={`/admin/persons/${r.id}` as never}>{r.name}</Link> },
    { key: "email", header: labels.columns.email, cell: (r) => r.email ?? "" },
    { key: "status", header: labels.columns.status, cell: (r) => <StatusBadge status={r.status} isOverridden={r.isOverridden} labels={labels.status} /> },
    { key: "member", header: labels.columns.member, cell: (r) => (r.isMember ? labels.yes : labels.no) },
    {
      key: "tags",
      header: labels.columns.tags,
      cell: (r) => (
        <span className="flex flex-wrap gap-1">
          {r.tags.map((k) => (
            <Badge key={k} variant="outline" style={tagLabel.get(k) ? { borderColor: tagLabel.get(k)!.color } : undefined}>
              {tagLabel.get(k)?.label ?? k}
            </Badge>
          ))}
        </span>
      ),
    },
    { key: "last_activity", header: labels.columns.lastActivity, cell: (r) => (r.lastActivityAt ? date.format(new Date(r.lastActivityAt)) : "") },
    { key: "created", header: labels.columns.created, cell: (r) => date.format(new Date(r.createdAt)) },
  ];

  const select = (key: string, label: string, opts: FilterOption[]): DataTableFilter => ({ kind: "select", key, label, allLabel: labels.all, options: opts });
  const filters: DataTableFilter[] = [
    { kind: "search", key: "q", label: labels.search, placeholder: labels.searchPlaceholder },
    select("status", labels.filterStatus, options.statuses),
    select("tag", labels.filterTag, options.tags),
    ...(options.segments.length ? [select("segment", labels.filterSegment, options.segments)] : []),
    select("locale", labels.filterLocale, options.locales),
    select("source", labels.filterSource, options.sources),
    select("tester", labels.filterTester, [
      { value: "yes", label: labels.yes },
      { value: "no", label: labels.no },
    ]),
  ];
  const filtered = Object.entries(searchParams).some(([k, v]) => k !== "page" && k !== "sort" && !!v);
  const pages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="grid gap-3">
      {canWrite ? (
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-muted-foreground text-sm" role="status">
            {selected.size === 1 ? labels.selectedOne : labels.selectedOther.replace(/\b7\b/, String(selected.size))}
          </span>
          <TagPicker tags={tags} selected={[...selected]} labels={labels.picker} onDone={() => setSelected(new Set())} />
        </div>
      ) : null}
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        filters={filters}
        searchParams={searchParams}
        cursorParam="page"
        nextCursor={page < pages ? String(page + 1) : null}
        prevCursor={page > 1 ? String(page - 1) : null}
        emptyState={
          filtered ? (
            <EmptyState title={labels.emptyFiltered} />
          ) : (
            <EmptyState
              title={labels.empty}
              action={
                <span className="flex gap-4">
                  <Link href={"/admin/persons/new"}>{labels.emptyCreate}</Link>
                  <Link href={"/admin/imports" as never}>{labels.emptyImport}</Link>
                </span>
              }
            />
          )
        }
        labels={{ pagination: labels.pagination, previous: labels.previous, next: labels.next, applyFilters: labels.applyFilters, filters: labels.filters }}
        caption={labels.pageOf.replace("{page}", String(page)).replace("{pages}", String(pages))}
      />
    </div>
  );
}
