/**
 * Side-by-side review diff (site spec section 5, version review screen): blocks are paired by
 * their stable `id`; each field gets a word-level LCS diff (`diffWords`).
 */
import { LOCALES, type Locale } from "../i18n";
import type { Block, BlockType } from "./blocks";
import type { VersionContent } from "./completeness";
import { richDocToPlainText, type RichDoc } from "./rich-text";

export type DiffOp = "eq" | "ins" | "del";
export type DiffSegment = { op: DiffOp; text: string };
export type FieldDiff = { field: string; changed: boolean; segments: DiffSegment[] };
export type BlockDiff = {
  blockId: string;
  type: BlockType;
  status: "unchanged" | "changed" | "inserted" | "deleted";
  /** True when the block kept its id but changed position relative to the other kept blocks. */
  moved: boolean;
  fromIndex: number | null;
  toIndex: number | null;
  fields: FieldDiff[];
};
export type LocaleDiff = {
  locale: Locale;
  title: FieldDiff;
  path: FieldDiff;
  seoTitle: FieldDiff;
  seoDescription: FieldDiff;
  excerpt: FieldDiff;
  blocks: BlockDiff[];
  changed: boolean;
};
export type VersionDiff = {
  locales: Locale[];
  addedLocales: Locale[];
  removedLocales: Locale[];
  byLocale: Partial<Record<Locale, LocaleDiff>>;
  identical: boolean;
};

const MAX_TOKENS = 4000;

function tokenize(text: string): string[] {
  return text.split(/(\s+)/).filter((t) => t.length > 0);
}

function push(out: DiffSegment[], op: DiffOp, text: string): void {
  const last = out[out.length - 1];
  if (last && last.op === op) last.text += text;
  else out.push({ op, text });
}

/** Word-level diff of two texts (whitespace kept as tokens), adjacent segments merged. */
export function diffWords(a: string, b: string): DiffSegment[] {
  if (a === b) return a ? [{ op: "eq", text: a }] : [];
  const x = tokenize(a);
  const y = tokenize(b);
  const out: DiffSegment[] = [];
  if (x.length > MAX_TOKENS || y.length > MAX_TOKENS) {
    if (a) out.push({ op: "del", text: a });
    if (b) out.push({ op: "ins", text: b });
    return out;
  }
  const n = x.length;
  const m = y.length;
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = x[i] === y[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) {
      push(out, "eq", x[i]!);
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      push(out, "del", x[i++]!);
    } else {
      push(out, "ins", y[j++]!);
    }
  }
  while (i < n) push(out, "del", x[i++]!);
  while (j < m) push(out, "ins", y[j++]!);
  return out;
}

function field(name: string, a: string, b: string): FieldDiff {
  return { field: name, changed: a !== b, segments: diffWords(a, b) };
}

function isRichDoc(v: unknown): v is RichDoc {
  return !!v && typeof v === "object" && (v as { type?: unknown }).type === "doc";
}

/** A block flattened to `field path -> text` (rich text as plain text, other values as JSON). */
export function blockFields(block: Block): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (value: unknown, path: string): void => {
    if (value === undefined) return;
    if (typeof value === "string") out[path] = value;
    else if (isRichDoc(value)) out[path] = richDocToPlainText(value);
    else if (Array.isArray(value)) value.forEach((v, i) => walk(v, `${path}.${i}`));
    else if (value && typeof value === "object" && !("kind" in value)) for (const [k, v] of Object.entries(value)) walk(v, path ? `${path}.${k}` : k);
    else out[path] = JSON.stringify(value);
  };
  for (const [k, v] of Object.entries(block)) if (k !== "id" && k !== "type") walk(v, k);
  return out;
}

/** Ids of the common blocks that keep their relative order (LCS over the two id sequences). */
function stableIds(a: string[], b: string[]): Set<string> {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const keep = new Set<string>();
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      keep.add(a[i]!);
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) i++;
    else j++;
  }
  return keep;
}

function diffBlocks(base: readonly Block[], next: readonly Block[]): BlockDiff[] {
  const baseIndex = new Map(base.map((b, i) => [b.id, i]));
  const nextIds = new Set(next.map((b) => b.id));
  const common = next.filter((b) => baseIndex.has(b.id)).map((b) => b.id);
  const commonBase = base.filter((b) => nextIds.has(b.id)).map((b) => b.id);
  const stable = stableIds(commonBase, common);
  const out: BlockDiff[] = [];
  next.forEach((b, toIndex) => {
    const fromIndex = baseIndex.get(b.id);
    const before = fromIndex === undefined ? undefined : base[fromIndex]!;
    const nf = blockFields(b);
    const bf = before && before.type === b.type ? blockFields(before) : {};
    const names = [...new Set([...Object.keys(bf), ...Object.keys(nf)])];
    const fields = names.map((f) => field(f, bf[f] ?? "", nf[f] ?? ""));
    const changed = !before || before.type !== b.type || JSON.stringify(before) !== JSON.stringify(b);
    out.push({
      blockId: b.id,
      type: b.type,
      status: !before ? "inserted" : changed ? "changed" : "unchanged",
      moved: !!before && !stable.has(b.id),
      fromIndex: fromIndex ?? null,
      toIndex,
      fields,
    });
  });
  base.forEach((b, fromIndex) => {
    if (nextIds.has(b.id)) return;
    const bf = blockFields(b);
    out.push({
      blockId: b.id,
      type: b.type,
      status: "deleted",
      moved: false,
      fromIndex,
      toIndex: null,
      fields: Object.entries(bf).map(([f, v]) => field(f, v, "")),
    });
  });
  return out;
}

/** Diffs `next` against `base` (null = everything inserted) for every locale either version has. */
export function diffVersions(base: VersionContent | null, next: VersionContent): VersionDiff {
  const baseLocales = base?.locales ?? [];
  const locales = LOCALES.filter((l) => next.locales.includes(l) || baseLocales.includes(l));
  const byLocale: Partial<Record<Locale, LocaleDiff>> = {};
  let identical = true;
  for (const l of locales) {
    const blocks = diffBlocks(base?.blocks?.[l] ?? [], next.blocks?.[l] ?? []);
    const d: LocaleDiff = {
      locale: l,
      title: field("title", base?.title?.[l] ?? "", next.title?.[l] ?? ""),
      path: field("path", base?.paths?.[l] ?? "", next.paths?.[l] ?? ""),
      seoTitle: field("seo.title", base?.seo?.[l]?.title ?? "", next.seo?.[l]?.title ?? ""),
      seoDescription: field("seo.description", base?.seo?.[l]?.description ?? "", next.seo?.[l]?.description ?? ""),
      excerpt: field("excerpt", base?.excerpt?.[l] ?? "", next.excerpt?.[l] ?? ""),
      blocks,
      changed: false,
    };
    d.changed =
      [d.title, d.path, d.seoTitle, d.seoDescription, d.excerpt].some((f) => f.changed) ||
      blocks.some((b) => b.status !== "unchanged" || b.moved) ||
      (base?.paths?.[l] === undefined) !== (next.paths?.[l] === undefined);
    if (d.changed) identical = false;
    byLocale[l] = d;
  }
  const addedLocales = LOCALES.filter((l) => next.locales.includes(l) && !baseLocales.includes(l));
  const removedLocales = LOCALES.filter((l) => baseLocales.includes(l) && !next.locales.includes(l));
  if (addedLocales.length || removedLocales.length) identical = false;
  if (!!base?.isMaterialChange !== !!next.isMaterialChange) identical = false;
  if ((base?.coverMediaId ?? null) !== (next.coverMediaId ?? null)) identical = false;
  return { locales, addedLocales, removedLocales, byLocale, identical };
}
