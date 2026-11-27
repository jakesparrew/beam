"use client";
/**
 * The till's buyer search (owner review November 2026: "a clear search bar with a dropdown that
 * finds clients easily"). From 2 characters it asks `findPosBuyer` (`persons.read`, debounced) and
 * lists the matches under the field: initials, name, email or customer number, member and credits
 * left. ARIA combobox pattern: the field owns the listbox through `aria-activedescendant`; Arrow
 * keys move, Enter picks, Escape closes. Picking a client sets `?personId=` and keeps the basket.
 * The last option, "+ Nieuwe klant", opens the walk-in quick-create prefilled with what was typed.
 * Without JavaScript the field is a GET search (`?q=`) and the server's matches arrive as
 * `initialMatches`.
 */
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { useRouter } from "next/navigation";
import { Button, Input, cn } from "@beam/ui";
import { findPosBuyer } from "../actions";
import type { PosBuyerMatch } from "../server/pos";
import { Initials } from "./kit";

export type PosBuyerSearchText = {
  label: string;
  searching: string;
  noMatch: string;
  newClient: string;
  member: string;
  days: string;
  nights: string;
  walkInTitle: string;
  firstName: string;
  lastName: string;
  phone: string;
  create: string;
};

/** "Jan Peeters" → first and last name; digits → the phone. */
function prefill(q: string): { firstName: string; lastName: string; phone: string } {
  const term = q.trim();
  if (/^[+\d][\d\s./-]{3,}$/.test(term)) return { firstName: "", lastName: "", phone: term };
  if (term.includes("@")) return { firstName: "", lastName: "", phone: "" };
  const [first = "", ...rest] = term.split(/\s+/);
  return { firstName: first, lastName: rest.join(" "), phone: "" };
}

export function PosBuyerSearch(props: {
  /** Id of the search field (the pay prompt focuses it). */
  id: string;
  /** False without `persons.read`: only the quick-create is shown. */
  canSearch: boolean;
  initialQuery: string;
  initialMatches: PosBuyerMatch[];
  /** The URL state to keep when a client is picked (tab, items, promo, client key). */
  keep: Record<string, string>;
  walkIn: (form: FormData) => Promise<void>;
  text: PosBuyerSearchText;
}) {
  const { text } = props;
  const router = useRouter();
  const listId = `${useId().replace(/:/g, "")}-list`;
  const [q, setQ] = useState(props.initialQuery);
  const [result, setResult] = useState<{ q: string; matches: PosBuyerMatch[] } | null>(props.initialQuery.trim().length >= 2 ? { q: props.initialQuery.trim(), matches: props.initialMatches } : null);
  const [open, setOpen] = useState(props.initialQuery.trim().length >= 2);
  const [active, setActive] = useState(0);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState(() => prefill(""));
  const root = useRef<HTMLDivElement>(null);
  const term = q.trim();
  const ready = term.length >= 2;
  const matches = ready && result?.q === term ? result.matches : [];
  const loading = ready && result?.q !== term;
  /** The options: the matches, then "+ Nieuwe klant". */
  const count = matches.length + 1;

  useEffect(() => {
    if (!props.canSearch || !ready || result?.q === term) return;
    // Debounced; an answer that arrives after the term changed is dropped.
    let live = true;
    const timer = setTimeout(() => {
      void findPosBuyer({ q: term }).then((r) => {
        if (!live) return;
        setResult({ q: term, matches: r.ok ? r.data : [] });
        setActive(0);
      });
    }, 200);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [term, ready, props.canSearch, result?.q]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  function pick(index: number) {
    const m = matches[index];
    setOpen(false);
    if (m) {
      const params = new URLSearchParams(Object.entries(props.keep).filter(([, v]) => v));
      params.set("personId", m.id);
      router.push(`/admin/pos?${params.toString()}` as never, { scroll: false });
      return;
    }
    setDraft(prefill(term));
    setCreating(true);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) return setOpen(ready);
      setActive((a) => (a + (e.key === "ArrowDown" ? 1 : count - 1)) % count);
    } else if (e.key === "Enter" && open && ready && !loading) {
      e.preventDefault();
      pick(active);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  const optionId = (i: number) => `${listId}-${i}`;
  const hint = (m: PosBuyerMatch) => [m.dayUnits ? `${text.days} ${m.dayUnits}` : null, m.nightUnits ? `${text.nights} ${m.nightUnits}` : null].filter(Boolean).join(" · ");
  const showList = props.canSearch && open && ready;

  return (
    <div className="grid gap-2">
      {props.canSearch ? (
        <div ref={root} className="relative">
          <form method="get" role="search" action="/admin/pos" onSubmit={(e) => e.preventDefault()}>
            {Object.entries(props.keep).map(([k, v]) => (v ? <input key={k} type="hidden" name={k} value={v} /> : null))}
            <label htmlFor={props.id} className="sr-only">
              {text.label}
            </label>
            <span aria-hidden="true" className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted-foreground">
              <svg viewBox="0 0 20 20" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.8">
                <circle cx="9" cy="9" r="6" />
                <path d="m14 14 4 4" strokeLinecap="round" />
              </svg>
            </span>
            <input
              id={props.id}
              name="q"
              type="search"
              role="combobox"
              aria-expanded={showList}
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={showList && !loading ? optionId(active) : undefined}
              autoComplete="off"
              placeholder={text.label}
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setOpen(true);
                setActive(0);
              }}
              onFocus={() => setOpen(true)}
              onKeyDown={onKeyDown}
              className="h-12 w-full rounded-lg border border-input bg-background pr-3 pl-9 text-[0.9375rem] shadow-xs outline-none placeholder:text-muted-foreground focus-visible:border-[#c9973a] focus-visible:ring-[3px] focus-visible:ring-[#c9973a]/25"
            />
          </form>
          {showList ? (
            <ul id={listId} role="listbox" className="absolute inset-x-0 top-full z-20 mt-1 grid max-h-96 overflow-auto rounded-lg border border-border bg-popover p-1 text-sm shadow-lg">
              {loading ? (
                <li role="presentation" className="px-3 py-2.5 text-muted-foreground">
                  {text.searching}
                </li>
              ) : null}
              {!loading && !matches.length ? (
                <li role="presentation" className="px-3 py-2.5 text-muted-foreground">
                  {text.noMatch}
                </li>
              ) : null}
              {matches.map((m, i) => (
                <li
                  key={m.id}
                  id={optionId(i)}
                  role="option"
                  aria-selected={active === i}
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => pick(i)}
                  className={cn("flex min-h-11 cursor-pointer items-center gap-3 rounded-md px-2 py-1.5", active === i && "bg-[#fbf6ec]")}
                >
                  <Initials id={m.id} name={m.name} />
                  <span className="grid min-w-0 flex-1">
                    <span className="truncate font-semibold">{m.name}</span>
                    <span className="truncate text-[0.75rem] text-muted-foreground">{m.email ?? m.customerNumber}</span>
                  </span>
                  <span className="flex shrink-0 items-center gap-1.5 text-[0.6875rem] text-muted-foreground tabular-nums">
                    {hint(m) ? <span>{hint(m)}</span> : null}
                    {m.isMember ? <span className="rounded-full bg-[#f7eedc] px-2 py-0.5 font-semibold text-[#8a5a14]">{text.member}</span> : null}
                  </span>
                </li>
              ))}
              {!loading ? (
                <li
                  id={optionId(matches.length)}
                  role="option"
                  aria-selected={active === matches.length}
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setActive(matches.length)}
                  onClick={() => pick(matches.length)}
                  className={cn("mt-1 flex min-h-11 cursor-pointer items-center gap-2 rounded-md border-t border-border px-3 font-semibold text-[#8a5a14]", active === matches.length && "bg-[#fbf6ec]")}
                >
                  <span aria-hidden="true">+</span> {text.newClient}
                  {term ? <span className="truncate font-normal text-muted-foreground">“{term}”</span> : null}
                </li>
              ) : null}
            </ul>
          ) : null}
        </div>
      ) : null}
      <details open={creating || !props.canSearch ? true : undefined} onToggle={(e) => setCreating(e.currentTarget.open)} className="text-sm">
        <summary className="flex min-h-11 cursor-pointer items-center gap-1 font-semibold text-[#8a5a14]">
          <span aria-hidden="true">+</span> {text.walkInTitle}
        </summary>
        <form key={`${draft.firstName}|${draft.lastName}|${draft.phone}`} action={props.walkIn} className="grid gap-2 pt-1 sm:grid-cols-2">
          {Object.entries(props.keep).map(([k, v]) => (k === "items" || k === "tab" ? <input key={k} type="hidden" name={k} value={v} /> : null))}
          <label className="grid gap-1">
            <span className="text-muted-foreground">{text.firstName}</span>
            <Input name="firstName" required className="h-11" autoComplete="given-name" defaultValue={draft.firstName} autoFocus={creating} />
          </label>
          <label className="grid gap-1">
            <span className="text-muted-foreground">{text.lastName}</span>
            <Input name="lastName" className="h-11" autoComplete="family-name" defaultValue={draft.lastName} />
          </label>
          <label className="grid gap-1">
            <span className="text-muted-foreground">{text.phone}</span>
            <Input name="phone" type="tel" className="h-11" autoComplete="tel" defaultValue={draft.phone} />
          </label>
          <Button type="submit" variant="outline" className="min-h-11 self-end">
            {text.create}
          </Button>
        </form>
      </details>
    </div>
  );
}
