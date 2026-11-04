"use client";
/**
 * The 360 (and company) timeline (crm spec 5.1, rules 3.26, 3.37): category chips, newest first,
 * infinite scroll (an IntersectionObserver on the end of the list, with a "Show older activity"
 * button as the keyboard and no-observer fallback). Pages come from `loadTimeline` with the last
 * row as cursor. A sensitive note is revealed one at a time through `revealSensitive` (purpose
 * `staff_view`, one `sensitive.read` audit row per reveal); the body lives only in this
 * component's state. Every string is a prop.
 */
import { useEffect, useRef, useState } from "react";
import { Button, EmptyState } from "@beam/ui";
import type { TIMELINE_CATEGORIES } from "@beam/core/crm";
import { loadTimeline } from "../../timeline/actions";
import { revealSensitive } from "../../sensitive/actions";
import { CategoryChips, type CategoryChip } from "./category-chips";
import { EventRow, type TimelineRowView } from "./event-row";

export type TimelineLabels = {
  title: string;
  empty: string;
  loadMore: string;
  sensitiveNote: string;
  reveal: string;
  all: string;
  error: string;
  loading: string;
};

type Cursor = { occurredAt: string; id: string } | null;
type Category = (typeof TIMELINE_CATEGORIES)[number];

export function Timeline({
  personId,
  companyId,
  initialRows,
  initialNext,
  chips,
  labels,
  canReveal,
  pageSize = 50,
}: {
  personId?: string;
  companyId?: string;
  initialRows: TimelineRowView[];
  initialNext: Cursor;
  chips: CategoryChip[];
  labels: TimelineLabels;
  canReveal: boolean;
  pageSize?: number;
}) {
  const [rows, setRows] = useState(initialRows);
  const [next, setNext] = useState<Cursor>(initialNext);
  const [selected, setSelected] = useState<Category[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [revealing, setRevealing] = useState<string | null>(null);
  const sentinel = useRef<HTMLDivElement | null>(null);

  const subject = personId ? { personId } : { companyId: companyId! };

  async function fetchPage(categories: Category[], before: Cursor, append: boolean) {
    setBusy(true);
    setError(null);
    const result = await loadTimeline({
      ...subject,
      ...(before ? { before } : {}),
      ...(categories.length ? { categories } : {}),
      limit: pageSize,
    });
    setBusy(false);
    if (!result.ok) {
      setError(labels.error);
      return;
    }
    setRows((prev) => (append ? [...prev, ...result.data.rows] : result.data.rows));
    setNext(result.data.nextBefore);
  }

  function changeCategories(nextSelected: Category[]) {
    setSelected(nextSelected);
    void fetchPage(nextSelected, null, false);
  }

  useEffect(() => {
    const el = sentinel.current;
    if (!el || !next || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting) && !busy && next) void fetchPage(selected, next, true);
    });
    observer.observe(el);
    return () => observer.disconnect();
    // fetchPage closes over the current state; re-observe when the cursor or filter changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [next, busy, selected]);

  async function reveal(eventId: string) {
    if (!personId) return;
    setRevealing(eventId);
    const result = await revealSensitive({ personId, eventIds: [eventId] });
    setRevealing(null);
    if (!result.ok) {
      setError(labels.error);
      return;
    }
    const note = result.data.notes.find((n) => n.eventId === eventId);
    if (note) setRevealed((prev) => ({ ...prev, [eventId]: note.body }));
  }

  return (
    <section className="grid gap-3" aria-labelledby="timeline-heading" data-testid="timeline">
      <h2 id="timeline-heading" className="text-lg font-semibold">
        {labels.title}
      </h2>
      <CategoryChips
        chips={chips}
        selected={selected}
        groupLabel={labels.title}
        allLabel={labels.all}
        onClear={() => changeCategories([])}
        onToggle={(key) => changeCategories(selected.includes(key as Category) ? selected.filter((k) => k !== key) : [...selected, key as Category])}
      />
      {error ? (
        <p role="status" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {rows.length ? (
        <ol className="grid" aria-busy={busy}>
          {rows.map((row) => (
            <EventRow
              key={row.id}
              row={row}
              labels={{ sensitiveNote: labels.sensitiveNote, reveal: labels.reveal }}
              canReveal={canReveal && !!personId}
              revealed={revealed[row.id] ?? null}
              revealing={revealing === row.id}
              onReveal={(id) => void reveal(id)}
            />
          ))}
        </ol>
      ) : busy ? (
        <p className="text-sm text-muted-foreground">{labels.loading}</p>
      ) : (
        <EmptyState title={labels.empty} />
      )}
      {next ? (
        <div ref={sentinel} className="flex justify-center">
          <Button type="button" variant="outline" disabled={busy} onClick={() => void fetchPage(selected, next, true)}>
            {busy ? labels.loading : labels.loadMore}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
