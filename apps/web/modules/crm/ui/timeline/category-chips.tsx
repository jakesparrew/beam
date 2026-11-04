/**
 * Timeline category filter (crm spec 4.7, 5.1): one toggle chip per category; none selected means
 * every category. Each chip is a `<button aria-pressed>`. Every string is a prop.
 */
import { cn } from "@beam/ui";

export type CategoryChip = { key: string; label: string };

export function CategoryChips({
  chips,
  selected,
  onToggle,
  onClear,
  allLabel,
  groupLabel,
}: {
  chips: CategoryChip[];
  selected: readonly string[];
  onToggle: (key: string) => void;
  onClear: () => void;
  allLabel: string;
  groupLabel: string;
}) {
  const base = "rounded-full border px-3 py-1 text-xs font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";
  return (
    <div role="group" aria-label={groupLabel} className="flex flex-wrap gap-2" data-testid="timeline-chips">
      <button type="button" aria-pressed={selected.length === 0} onClick={onClear} className={cn(base, selected.length === 0 ? "bg-primary text-primary-foreground" : "bg-background")}>
        {allLabel}
      </button>
      {chips.map((c) => {
        const on = selected.includes(c.key);
        return (
          <button key={c.key} type="button" aria-pressed={on} data-category={c.key} onClick={() => onToggle(c.key)} className={cn(base, on ? "bg-primary text-primary-foreground" : "bg-background")}>
            {c.label}
          </button>
        );
      })}
    </div>
  );
}
