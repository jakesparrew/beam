"use client";
/**
 * The canvas of the block editor (email spec section 5, `/admin/templates/[id]`): the blocks of
 * the open locale in order, nested `columns` and `dynamic` content indented, with select, move
 * up and down, and remove. Also the pure tree helpers the editor uses: every block id is unique
 * within a locale, so blocks are found, replaced, moved and removed by id at any depth.
 */
import { Badge, Button, cn } from "@beam/ui";
import { newBlockId, type Block, type BlockType } from "@beam/core/email";

export type EditorLabels = Readonly<Record<string, string>>;

/** A label, or the key while the catalogue lacks it (never throws in the client). */
export const lab = (labels: EditorLabels, key: string, params: Record<string, string | number> = {}): string =>
  (labels[key] ?? key).replace(/\{(\w+)\}/g, (m, name: string) => (name in params ? String(params[name]) : m));

/** A new block of `type` with editable defaults. */
export function newBlock(type: BlockType): Block {
  const id = newBlockId();
  switch (type) {
    case "heading":
      return { id, type, level: 2, text: "" };
    case "text":
      return { id, type, markdown: "" };
    case "image":
      return { id, type, fileId: "00000000-0000-4000-8000-000000000000", alt: "", width: 600 };
    case "button":
      return { id, type, label: "", href: "https://beam.be", style: "primary" };
    case "divider":
      return { id, type };
    case "spacer":
      return { id, type, height: 24 };
    case "columns":
      return { id, type, stackOnMobile: true, columns: [{ width: 50, blocks: [] }, { width: 50, blocks: [] }] };
    case "product":
      return { id, type, productId: "00000000-0000-4000-8000-000000000000", showPrice: true, ctaLabel: "" };
    case "event":
      return { id, type, sessionId: "00000000-0000-4000-8000-000000000000", ctaLabel: "" };
    case "dynamic":
      return { id, type, variants: [{ when: { status: "member" }, blocks: [] }], fallback: [] };
  }
}

/** A deep copy with fresh ids (copying a locale's structure to another locale keeps ids unique there). */
export function cloneWithNewIds<B extends Block>(block: B): B {
  const copy = structuredClone(block) as Block;
  copy.id = newBlockId();
  if (copy.type === "columns") copy.columns = copy.columns.map((c) => ({ ...c, blocks: c.blocks.map((b) => cloneWithNewIds(b)) }));
  if (copy.type === "dynamic") {
    copy.variants = copy.variants.map((v) => ({ ...v, blocks: v.blocks.map((b) => cloneWithNewIds(b)) }));
    copy.fallback = copy.fallback.map((b) => cloneWithNewIds(b));
  }
  return copy as B;
}

type AnyList = Block[];

/** Applies `fn` to every block list of the tree (the top list and every nested list). */
function mapLists(list: AnyList, fn: (list: AnyList) => AnyList): AnyList {
  return fn(list).map((b) => {
    if (b.type === "columns") return { ...b, columns: b.columns.map((c) => ({ ...c, blocks: mapLists(c.blocks, fn) as typeof c.blocks })) };
    if (b.type === "dynamic") {
      return { ...b, variants: b.variants.map((v) => ({ ...v, blocks: mapLists(v.blocks, fn) as typeof v.blocks })), fallback: mapLists(b.fallback, fn) as typeof b.fallback };
    }
    return b;
  });
}

export function findBlock(list: readonly Block[], id: string): Block | null {
  for (const b of list) {
    if (b.id === id) return b;
    const nested = b.type === "columns" ? b.columns.flatMap((c) => c.blocks) : b.type === "dynamic" ? [...b.variants.flatMap((v) => v.blocks), ...b.fallback] : [];
    const hit = findBlock(nested, id);
    if (hit) return hit;
  }
  return null;
}

export function replaceBlock(list: AnyList, id: string, next: Block): AnyList {
  return mapLists(list, (l) => l.map((b) => (b.id === id ? next : b)));
}

export function removeBlock(list: AnyList, id: string): AnyList {
  return mapLists(list, (l) => l.filter((b) => b.id !== id));
}

export function moveBlock(list: AnyList, id: string, delta: -1 | 1): AnyList {
  return mapLists(list, (l) => {
    const i = l.findIndex((b) => b.id === id);
    const j = i + delta;
    if (i === -1 || j < 0 || j >= l.length) return l;
    const copy = [...l];
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
    return copy;
  });
}

/** A one-line summary of a block for the canvas. */
function summary(block: Block, labels: EditorLabels): string {
  switch (block.type) {
    case "heading":
      return block.text || lab(labels, "empty_text");
    case "text":
      return block.markdown.slice(0, 120) || lab(labels, "empty_text");
    case "button":
      return `${block.label || lab(labels, "empty_text")} → ${block.href}`;
    case "image":
      return block.alt ? block.alt : lab(labels, "decorative_image");
    case "spacer":
      return `${block.height} px`;
    case "columns":
      return block.columns.map((c) => `${c.width}%`).join(" | ");
    case "product":
      return block.ctaLabel || block.productId;
    case "event":
      return block.ctaLabel || block.sessionId;
    case "dynamic":
      return lab(labels, "dynamic_summary", { count: block.variants.length });
    default:
      return "";
  }
}

export type BlockCanvasProps = {
  blocks: readonly Block[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onChange: (blocks: Block[]) => void;
  /** Block ids with an accessibility or card warning. */
  warnedIds: ReadonlySet<string>;
  labels: EditorLabels;
  disabled?: boolean;
};

function Row({ block, depth, props }: { block: Block; depth: number; props: BlockCanvasProps }) {
  const { labels, selectedId, onSelect, onChange, blocks, disabled } = props;
  const nested: { title: string; list: readonly Block[] }[] =
    block.type === "columns"
      ? block.columns.map((c, i) => ({ title: lab(labels, "column_n", { n: i + 1 }), list: c.blocks }))
      : block.type === "dynamic"
        ? [...block.variants.map((v, i) => ({ title: lab(labels, "variant_n", { n: i + 1 }), list: v.blocks })), { title: lab(labels, "fallback"), list: block.fallback }]
        : [];
  return (
    <li className="grid gap-1">
      <div
        className={cn("flex items-center gap-2 rounded-md border px-3 py-2", selectedId === block.id ? "border-primary bg-primary/5" : "border-border")}
        style={{ marginLeft: depth * 16 }}
      >
        <button type="button" className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => onSelect(block.id)} aria-pressed={selectedId === block.id} data-block-id={block.id}>
          <Badge variant="secondary">{lab(labels, `type_${block.type}`)}</Badge>
          <span className="truncate text-sm">{summary(block, labels)}</span>
          {props.warnedIds.has(block.id) ? <Badge variant="destructive">{lab(labels, "warning")}</Badge> : null}
        </button>
        <Button type="button" size="sm" variant="ghost" disabled={disabled} aria-label={lab(labels, "move_up")} onClick={() => onChange(moveBlock([...blocks], block.id, -1))}>
          ↑
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={disabled} aria-label={lab(labels, "move_down")} onClick={() => onChange(moveBlock([...blocks], block.id, 1))}>
          ↓
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={disabled} aria-label={lab(labels, "remove")} onClick={() => onChange(removeBlock([...blocks], block.id))}>
          ✕
        </Button>
      </div>
      {nested.map((n) => (
        <div key={n.title} className="grid gap-1" style={{ marginLeft: (depth + 1) * 16 }}>
          <span className="text-xs text-muted-foreground">{n.title}</span>
          {n.list.length ? (
            <ul className="grid gap-1">
              {n.list.map((b) => (
                <Row key={b.id} block={b} depth={0} props={props} />
              ))}
            </ul>
          ) : (
            <span className="text-xs italic text-muted-foreground">{lab(labels, "empty_list")}</span>
          )}
        </div>
      ))}
    </li>
  );
}

export function BlockCanvas(props: BlockCanvasProps) {
  if (!props.blocks.length) return <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">{lab(props.labels, "canvas_empty")}</p>;
  return (
    <ul className="grid gap-2" aria-label={lab(props.labels, "canvas")}>
      {props.blocks.map((b) => (
        <Row key={b.id} block={b} depth={0} props={props} />
      ))}
    </ul>
  );
}
