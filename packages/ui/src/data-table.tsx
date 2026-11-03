import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "./cn";
import { buttonVariants } from "./components/button";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "./components/table";

export type DataTableColumn<T> = {
  /** Stable column key (React key and `data-column`). */
  key: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  align?: "left" | "right" | "center";
  className?: string;
};

export type DataTableFilter =
  | { kind: "search"; key: string; label: string; placeholder?: string }
  | {
      kind: "select";
      key: string;
      label: string;
      options: { value: string; label: string }[];
      /** Label of the "no filter" option, for example "All statuses". */
      allLabel: string;
    };

export type SearchParamsInput =
  URLSearchParams | Record<string, string | string[] | undefined>;

export type DataTableLabels = {
  /** Accessible name of the pagination landmark, for example "Pagination". */
  pagination: string;
  previous: string;
  next: string;
  /** Submit button of the filter form, for example "Apply". */
  applyFilters?: string;
  /** Accessible name of the filter form, for example "Filters". */
  filters?: string;
};

export type DataTableProps<T> = {
  columns: DataTableColumn<T>[];
  rows: T[];
  /** Opaque keyset cursor of the next page (from the query); `null` on the last page. */
  nextCursor?: string | null;
  /** Opaque keyset cursor of the previous page; `null` on the first page. */
  prevCursor?: string | null;
  /** Column filters, rendered as a GET form so the state lives in the URL. */
  filters?: DataTableFilter[];
  /** Shown instead of the table when `rows` is empty (usually an `EmptyState`). */
  emptyState: ReactNode;
  /** Makes the first cell of each row a link to this href. */
  onRowHref?: (row: T) => string;
  /** The page's current search params, kept in cursor links and filter submits. */
  searchParams?: SearchParamsInput;
  /** URL parameter that carries the cursor; default `cursor`. */
  cursorParam?: string;
  rowKey?: (row: T, index: number) => string;
  labels: DataTableLabels;
  caption?: string;
  /** Extra controls above the table (for example a CSV export link). */
  toolbar?: ReactNode;
  className?: string;
};

function toEntries(input: SearchParamsInput | undefined): [string, string][] {
  if (!input) return [];
  if (input instanceof URLSearchParams) return [...input.entries()];
  const out: [string, string][] = [];
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    for (const v of Array.isArray(value) ? value : [value]) out.push([key, v]);
  }
  return out;
}

/** `?<params>` with `cursorParam` replaced by `cursor` (other params kept). */
export function cursorHref(
  searchParams: SearchParamsInput | undefined,
  cursorParam: string,
  cursor: string,
): string {
  const params = new URLSearchParams(
    toEntries(searchParams).filter(([k]) => k !== cursorParam),
  );
  params.set(cursorParam, cursor);
  return `?${params.toString()}`;
}

const alignClass = {
  left: "text-left",
  right: "text-right",
  center: "text-center",
} as const;

/**
 * Server-rendered, URL-driven table (no client fetching): rows come from a keyset
 * query, pagination and filters are plain links and a GET form, so it works without
 * JavaScript and every control is reachable by Tab (PL-90).
 */
export function DataTable<T>({
  columns,
  rows,
  nextCursor,
  prevCursor,
  filters,
  emptyState,
  onRowHref,
  searchParams,
  cursorParam = "cursor",
  rowKey,
  labels,
  caption,
  toolbar,
  className,
}: DataTableProps<T>) {
  const current = toEntries(searchParams);
  const valueOf = (key: string) => current.find(([k]) => k === key)?.[1] ?? "";
  const filterKeys = new Set((filters ?? []).map((f) => f.key));
  const keyOf =
    rowKey ??
    ((row: T, index: number) => {
      const id = (row as { id?: unknown }).id;
      return typeof id === "string" || typeof id === "number"
        ? String(id)
        : String(index);
    });
  const hasPages = Boolean(nextCursor || prevCursor);

  return (
    <div
      data-slot="data-table"
      className={cn("flex flex-col gap-4", className)}
    >
      {filters?.length || toolbar ? (
        <div className="flex flex-wrap items-end justify-between gap-3">
          {filters?.length ? (
            <form
              method="get"
              role="search"
              aria-label={labels.filters}
              className="flex flex-wrap items-end gap-3"
            >
              {current
                .filter(([k]) => k !== cursorParam && !filterKeys.has(k))
                .map(([k, v], i) => (
                  <input key={`${k}-${i}`} type="hidden" name={k} value={v} />
                ))}
              {filters.map((filter) => {
                const id = `data-table-filter-${filter.key}`;
                return (
                  <div key={filter.key} className="grid gap-1.5">
                    <label htmlFor={id} className="text-sm font-medium">
                      {filter.label}
                    </label>
                    {filter.kind === "search" ? (
                      <input
                        id={id}
                        type="search"
                        name={filter.key}
                        defaultValue={valueOf(filter.key)}
                        placeholder={filter.placeholder}
                        className="h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                      />
                    ) : (
                      <select
                        id={id}
                        name={filter.key}
                        defaultValue={valueOf(filter.key)}
                        className="h-9 rounded-md border border-input bg-background px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                      >
                        <option value="">{filter.allLabel}</option>
                        {filter.options.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>
                );
              })}
              {labels.applyFilters ? (
                <button
                  type="submit"
                  className={buttonVariants({ variant: "outline" })}
                >
                  {labels.applyFilters}
                </button>
              ) : null}
            </form>
          ) : (
            <span />
          )}
          {toolbar ? (
            <div className="flex items-center gap-2">{toolbar}</div>
          ) : null}
        </div>
      ) : null}

      {rows.length === 0 ? (
        emptyState
      ) : (
        <Table>
          {caption ? (
            <TableCaption className="sr-only">{caption}</TableCaption>
          ) : null}
          <TableHeader>
            <TableRow>
              {columns.map((col) => (
                <TableHead
                  key={col.key}
                  scope="col"
                  className={cn(
                    col.align && alignClass[col.align],
                    col.className,
                  )}
                >
                  {col.header}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row, index) => (
              <TableRow key={keyOf(row, index)}>
                {columns.map((col, c) => {
                  const content = col.cell(row);
                  return (
                    <TableCell
                      key={col.key}
                      data-column={col.key}
                      className={cn(
                        col.align && alignClass[col.align],
                        col.className,
                      )}
                    >
                      {c === 0 && onRowHref ? (
                        <a
                          href={onRowHref(row)}
                          className="font-medium text-primary underline-offset-4 hover:underline"
                        >
                          {content}
                        </a>
                      ) : (
                        content
                      )}
                    </TableCell>
                  );
                })}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {hasPages ? (
        <nav
          aria-label={labels.pagination}
          data-slot="data-table-pagination"
          className="flex justify-end gap-2"
        >
          {prevCursor ? (
            <a
              href={cursorHref(searchParams, cursorParam, prevCursor)}
              rel="prev"
              className={cn(
                buttonVariants({ variant: "outline", size: "sm" }),
                "gap-1",
              )}
            >
              <ChevronLeftIcon aria-hidden />
              {labels.previous}
            </a>
          ) : (
            <span
              aria-disabled="true"
              className={cn(
                buttonVariants({ variant: "outline", size: "sm" }),
                "pointer-events-none gap-1 opacity-50",
              )}
            >
              <ChevronLeftIcon aria-hidden />
              {labels.previous}
            </span>
          )}
          {nextCursor ? (
            <a
              href={cursorHref(searchParams, cursorParam, nextCursor)}
              rel="next"
              className={cn(
                buttonVariants({ variant: "outline", size: "sm" }),
                "gap-1",
              )}
            >
              {labels.next}
              <ChevronRightIcon aria-hidden />
            </a>
          ) : (
            <span
              aria-disabled="true"
              className={cn(
                buttonVariants({ variant: "outline", size: "sm" }),
                "pointer-events-none gap-1 opacity-50",
              )}
            >
              {labels.next}
              <ChevronRightIcon aria-hidden />
            </span>
          )}
        </nav>
      ) : null}
    </div>
  );
}
