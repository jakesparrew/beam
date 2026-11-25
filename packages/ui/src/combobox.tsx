"use client";
/**
 * A searchable picker for long lists (owner's review, section 10: "a selection of entries in the
 * dropdown, with a search option at the bottom"). The trigger is a button that shows the chosen
 * option; the popup shows the first `initialCount` options with a search field at the bottom that
 * filters every option (or asks `onSearch` for remote results). ARIA combobox pattern: the search
 * field owns the listbox through `aria-activedescendant`; Arrow keys move, Enter picks, Escape
 * closes. With `name`, a hidden input carries the value, so it also works in plain GET/POST forms.
 * Every string arrives through `labels`.
 */
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { cn } from "./cn";

export type ComboboxOption = { value: string; label: string; hint?: string };

export type ComboboxLabels = {
  /** Trigger text while nothing is chosen. */
  placeholder: string;
  /** Label and placeholder of the search field. */
  search: string;
  noMatch: string;
  /** Under the short list, `{count}` = options not shown ("12 more: type to search"). */
  more?: string;
};

export type ComboboxProps = {
  options: readonly ComboboxOption[];
  value?: string;
  defaultValue?: string;
  onChange?: (value: string, option: ComboboxOption | null) => void;
  /** Name of the hidden input that carries the value in a native form. */
  name?: string;
  /** Options shown before typing (default 8). */
  initialCount?: number;
  /** Remote search from 2 characters; replaces the local filter while typing. */
  onSearch?: (q: string) => Promise<ComboboxOption[]>;
  labels: ComboboxLabels;
  id?: string;
  disabled?: boolean;
  className?: string;
  title?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean | "true" | "false";
  "aria-label"?: string;
  /** Id of the visible label; the trigger is then named "<label> <chosen option>". */
  "aria-labelledby"?: string;
};

/** Case- and accent-insensitive text for matching ("Séance" matches "seance"). */
const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** The options to list for `q`: the first `count` without a query, else every match (at most 50). */
export function filterOptions(options: readonly ComboboxOption[], q: string, count: number): ComboboxOption[] {
  const term = fold(q.trim());
  if (!term) return options.slice(0, count);
  return options.filter((o) => fold(`${o.label} ${o.hint ?? ""}`).includes(term)).slice(0, 50);
}

export function Combobox({ options, value, defaultValue, onChange, name, initialCount = 8, onSearch, labels, id, disabled, className, title, ...aria }: ComboboxProps) {
  const auto = useId().replace(/:/g, "");
  const listId = `${auto}-list`;
  const [inner, setInner] = useState(defaultValue ?? "");
  const current = value ?? inner;
  const [picked, setPicked] = useState<ComboboxOption | null>(null);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  /** The latest remote answer with the query it answers (an older answer is not shown). */
  const [remote, setRemote] = useState<{ q: string; options: ComboboxOption[] } | null>(null);
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  const remoteMode = !!onSearch && q.trim().length >= 2;
  const shown = remoteMode ? (remote?.q === q.trim() ? remote.options : []) : filterOptions(options, q, initialCount);
  const hidden = !q.trim() && !onSearch ? options.length - shown.length : 0;
  const selected = options.find((o) => o.value === current) ?? (picked?.value === current ? picked : null);

  useEffect(() => {
    if (!open) return;
    search.current?.focus();
    const close = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  useEffect(() => {
    const term = q.trim();
    if (!onSearch || term.length < 2) return;
    let live = true;
    const timer = setTimeout(() => {
      onSearch(term)
        .then((r) => live && setRemote({ q: term, options: r }))
        .catch(() => live && setRemote({ q: term, options: [] }));
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [q, onSearch]);

  const pick = (o: ComboboxOption) => {
    if (value === undefined) setInner(o.value);
    setPicked(o);
    onChange?.(o.value, o);
    setOpen(false);
    setQ("");
    trigger.current?.focus();
  };

  function onSearchKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (shown.length) setActive((i) => (i + (e.key === "ArrowDown" ? 1 : shown.length - 1)) % shown.length);
    } else if (e.key === "Enter") {
      // Never submit the surrounding form from the search field.
      e.preventDefault();
      const o = shown[active];
      if (o) pick(o);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
      trigger.current?.focus();
    } else if (e.key === "Tab") setOpen(false);
  }

  const optionId = (i: number) => `${auto}-opt-${i}`;
  return (
    <div ref={root} className={cn("relative w-full min-w-48", className)} data-slot="combobox">
      {name ? <input type="hidden" name={name} value={current} /> : null}
      <button
        ref={trigger}
        type="button"
        id={id}
        title={title}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-describedby={aria["aria-describedby"]}
        aria-invalid={aria["aria-invalid"]}
        aria-label={aria["aria-label"]}
        aria-labelledby={aria["aria-labelledby"] ? `${aria["aria-labelledby"]} ${auto}-value` : undefined}
        onClick={() => (setOpen((o) => !o), setActive(0))}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && !open) {
            e.preventDefault();
            setOpen(true);
            setActive(0);
          }
        }}
        className="flex h-9 w-full items-center justify-between gap-2 rounded-md border border-input bg-transparent px-3 text-left text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-60 aria-invalid:border-destructive"
      >
        <span id={`${auto}-value`} className={cn("truncate", !selected && "text-muted-foreground")}>{selected?.label ?? labels.placeholder}</span>
        <span aria-hidden="true" className="text-muted-foreground">
          ▾
        </span>
      </button>
      {open ? (
        <div className="absolute z-50 mt-1 grid w-full min-w-64 rounded-md border bg-popover text-popover-foreground shadow-md">
          <ul role="listbox" id={listId} aria-label={labels.placeholder} className="max-h-64 overflow-y-auto p-1">
            {shown.map((o, i) => (
              <li
                key={o.value}
                id={optionId(i)}
                role="option"
                aria-selected={o.value === current}
                data-active={i === active ? "true" : undefined}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(o)}
                className={cn("grid cursor-pointer rounded-sm px-2 py-1.5 text-sm", i === active && "bg-accent text-accent-foreground", o.value === current && "font-medium")}
              >
                <span>{o.label}</span>
                {o.hint ? <span className="text-xs text-muted-foreground">{o.hint}</span> : null}
              </li>
            ))}
            {shown.length === 0 && (q.trim() || !onSearch) ? <li className="px-2 py-1.5 text-sm text-muted-foreground">{labels.noMatch}</li> : null}
          </ul>
          {hidden > 0 && labels.more ? <p className="px-3 pb-1 text-xs text-muted-foreground">{labels.more.replace("{count}", String(hidden))}</p> : null}
          <div className="border-t p-2">
            <input
              ref={search}
              type="search"
              role="combobox"
              aria-label={labels.search}
              aria-expanded="true"
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={shown[active] ? optionId(active) : undefined}
              placeholder={labels.search}
              value={q}
              onChange={(e) => (setQ(e.target.value), setActive(0))}
              onKeyDown={onSearchKey}
              className="h-8 w-full rounded-md border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
