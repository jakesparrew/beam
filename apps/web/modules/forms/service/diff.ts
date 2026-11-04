/**
 * Version comparison (forms spec section 4 queries `diffVersions`, section 5 "versions"; forms-P5).
 * Pure: compares two stored `form_versions` rows by key, never by array position, so a reordered
 * list shows as `moved` on the sections only. Every entry names the properties that changed
 * (`label`, `options`, `visibleIf`, ...) and never carries a value, so the diff can be shown or
 * audited without copying content.
 */
import type { FormVersionRow as DbFormVersionRow } from "@beam/db/schema";
import { canonicalJson, type FormDefinition, type FormScoring } from "@beam/core/forms";
import { parseVersion } from "./versions";

export type FormVersionRow = Pick<DbFormVersionRow, "id" | "version" | "definition" | "scoring" | "locales">;

/** One keyed item that exists in both versions with different content. */
export type ChangedItem = { key: string; props: string[] };

export type KeyedDiff = { added: string[]; removed: string[]; changed: ChangedItem[] };

export type VersionDiff = {
  from: { id: string; version: number };
  to: { id: string; version: number };
  /** Top-level texts and settings (`title`, `intro`, `settings.<name>`). */
  form: string[];
  locales: { added: string[]; removed: string[] };
  sections: KeyedDiff & { moved: string[] };
  fields: KeyedDiff;
  logic: KeyedDiff;
  endings: KeyedDiff;
  scoring: { dimensions: KeyedDiff; outcomes: KeyedDiff; total: string[]; defaultOutcome: boolean };
  /** True when nothing differs. */
  same: boolean;
};

const same = (a: unknown, b: unknown) => canonicalJson(a ?? null) === canonicalJson(b ?? null);

/** Property names whose values differ between two objects (union of both key sets, sorted). */
function changedProps(a: Record<string, unknown>, b: Record<string, unknown>, skip: readonly string[] = []): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].filter((k) => !skip.includes(k) && !same(a[k], b[k])).sort();
}

function keyed<T extends { key: string }>(a: readonly T[], b: readonly T[], skip: readonly string[] = []): KeyedDiff {
  const am = new Map(a.map((x) => [x.key, x]));
  const bm = new Map(b.map((x) => [x.key, x]));
  const changed: ChangedItem[] = [];
  for (const [key, x] of am) {
    const y = bm.get(key);
    if (!y) continue;
    const props = changedProps(x as Record<string, unknown>, y as Record<string, unknown>, skip);
    if (props.length) changed.push({ key, props });
  }
  return {
    added: [...bm.keys()].filter((k) => !am.has(k)),
    removed: [...am.keys()].filter((k) => !bm.has(k)),
    changed,
  };
}

function formLevel(a: FormDefinition, b: FormDefinition): string[] {
  const out: string[] = [];
  if (!same(a.title, b.title)) out.push("title");
  if (!same(a.intro, b.intro)) out.push("intro");
  for (const p of changedProps(a.settings as Record<string, unknown>, b.settings as Record<string, unknown>)) out.push(`settings.${p}`);
  return out;
}

function scoringDiff(a: FormScoring, b: FormScoring): VersionDiff["scoring"] {
  const total = a.total && b.total ? changedProps(a.total, b.total) : a.total || b.total ? ["total"] : [];
  return {
    dimensions: keyed(a.dimensions, b.dimensions),
    outcomes: keyed(a.outcomes, b.outcomes),
    total,
    defaultOutcome: (a.defaultOutcomeKey ?? null) !== (b.defaultOutcomeKey ?? null),
  };
}

const isEmpty = (d: KeyedDiff) => !d.added.length && !d.removed.length && !d.changed.length;

/** Compares version `a` (older) with `b` (newer): what was added, removed and changed by key. */
export function diffVersions(a: FormVersionRow, b: FormVersionRow): VersionDiff {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  const fa = Object.values(va.definition.fields);
  const fb = Object.values(vb.definition.fields);
  const sections = keyed(va.definition.sections, vb.definition.sections);
  const orderA = va.definition.sections.map((s) => s.key).filter((k) => vb.definition.sections.some((s) => s.key === k));
  const orderB = vb.definition.sections.map((s) => s.key).filter((k) => orderA.includes(k));
  const moved = orderA.filter((k, i) => orderB[i] !== k);
  const diff: Omit<VersionDiff, "same"> = {
    from: { id: a.id, version: a.version },
    to: { id: b.id, version: b.version },
    form: formLevel(va.definition, vb.definition),
    locales: { added: vb.locales.filter((l) => !va.locales.includes(l)), removed: va.locales.filter((l) => !vb.locales.includes(l)) },
    sections: { ...sections, moved },
    fields: keyed(fa, fb),
    logic: keyed(va.definition.logic, vb.definition.logic),
    endings: keyed(va.definition.endings, vb.definition.endings),
    scoring: scoringDiff(va.scoring, vb.scoring),
  };
  const nothing =
    !diff.form.length &&
    !diff.locales.added.length &&
    !diff.locales.removed.length &&
    isEmpty(diff.sections) &&
    !moved.length &&
    isEmpty(diff.fields) &&
    isEmpty(diff.logic) &&
    isEmpty(diff.endings) &&
    isEmpty(diff.scoring.dimensions) &&
    isEmpty(diff.scoring.outcomes) &&
    !diff.scoring.total.length &&
    !diff.scoring.defaultOutcome;
  return { ...diff, same: nothing };
}
