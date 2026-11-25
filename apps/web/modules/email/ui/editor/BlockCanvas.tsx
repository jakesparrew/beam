"use client";
/**
 * The visual canvas of the block editor (email spec section 5, `/admin/templates/[id]` and the
 * campaign editor; owner's review, section 10: "a visual email builder"): the blocks of the open
 * locale drawn as the email looks, on desktop or mobile width, with select, drag and drop, move
 * up and down, and remove. Also the pure tree helpers the editor uses: every block id is unique
 * within a locale, so blocks are found, replaced, moved and removed by id at any depth.
 */
import { useState, type DragEvent, type KeyboardEvent, type ReactNode } from "react";
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
    case "webinar":
      return { id, type, webinarId: "00000000-0000-4000-8000-000000000000", ctaLabel: "" };
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
    case "webinar":
      return block.ctaLabel || block.webinarId;
    case "dynamic":
      return lab(labels, "dynamic_summary", { count: block.variants.length });
    default:
      return "";
  }
}

/** Moves block `id` to the place of `overId` when both sit in the same list (drag and drop); otherwise unchanged. */
export function reorderBlock(list: AnyList, id: string, overId: string): AnyList {
  if (id === overId) return list;
  return mapLists(list, (l) => {
    const from = l.findIndex((b) => b.id === id);
    const to = l.findIndex((b) => b.id === overId);
    if (from === -1 || to === -1) return l;
    const copy = [...l];
    const [moved] = copy.splice(from, 1);
    copy.splice(to, 0, moved!);
    return copy;
  });
}

/** The drag types of the canvas: a block being moved, or a new block from the palette. */
export const BLOCK_DRAG = "application/x-beam-email-block";
export const PALETTE_DRAG = "application/x-beam-email-palette";

/** BEAM email colours, mirroring `BRAND` of `packages/email/src/layout/brand.ts` (the client cannot import that package). */
const PAPER = { color: "#1f3a2e", text: "#1c1c1c", muted: "#5c5c5c", background: "#f4f2ee", surface: "#ffffff", border: "#e5e1d8", font: "Helvetica, Arial, sans-serif" };
/** The placeholder id of a new image, product, event or webinar block. */
const PLACEHOLDER_ID = "00000000-0000-4000-8000-000000000000";

/** Inline Markdown of a text block as React nodes: bold, italic, links; tokens stay as typed. */
function inline(text: string): ReactNode[] {
  return text.split(/(\{\{[^}]*\}\}|\*\*[^*]+\*\*|\[[^\]]+\]\([^)\s]+\)|\*[^*\s][^*]*\*|_[^_\s][^_]*_)/g).map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) return <strong key={i}>{part.slice(2, -2)}</strong>;
    if (part.startsWith("[")) return <span key={i} style={{ color: PAPER.color, textDecoration: "underline" }}>{part.slice(1, part.indexOf("]("))}</span>;
    if (/^([*_]).+\1$/.test(part) && !part.startsWith("{{")) return <em key={i}>{part.slice(1, -1)}</em>;
    return part;
  });
}

/** The limited Markdown of a text block (paragraphs, bullet and numbered lists) as spans (they sit inside a button). */
function MarkdownPreview({ markdown, empty }: { markdown: string; empty: string }) {
  if (!markdown.trim()) return <span className="block italic" style={{ color: PAPER.muted }}>{empty}</span>;
  return (
    <>
      {markdown.replace(/\r\n?/g, "\n").split(/\n{2,}/).map((para, p) => (
        <span key={p} className="mb-2 block last:mb-0">
          {para.split("\n").map((line, i) => {
            const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
            return (
              <span key={i} className={cn("block", bullet && "pl-4")}>
                {bullet ? <>{"• "}{inline(bullet[1] ?? "")}</> : inline(line)}
              </span>
            );
          })}
        </span>
      ))}
    </>
  );
}

function CardPreview({ title, cta, labels }: { title: string; cta: string; labels: EditorLabels }) {
  return (
    <span className="block rounded border p-3" style={{ borderColor: PAPER.border }}>
      <span className="block font-bold">{title}</span>
      <span className="mt-2 inline-block rounded-md px-4 py-2 text-sm font-semibold" style={{ background: PAPER.color, color: PAPER.surface }}>
        {cta || lab(labels, "empty_text")}
      </span>
    </span>
  );
}

/** How a leaf block looks in the email (an approximation of the MJML output; the live preview below renders the real one). */
function LeafPreview({ block, labels }: { block: Block; labels: EditorLabels }) {
  switch (block.type) {
    case "heading": {
      const size = block.level === 1 ? 26 : block.level === 2 ? 21 : 18;
      return <span className="block font-bold leading-tight" style={{ fontSize: size }}>{block.text || <span className="italic" style={{ color: PAPER.muted }}>{lab(labels, "empty_text")}</span>}</span>;
    }
    case "text":
      return <MarkdownPreview markdown={block.markdown} empty={lab(labels, "empty_text")} />;
    case "image":
      return block.fileId === PLACEHOLDER_ID ? (
        <span className="flex h-32 items-center justify-center rounded border border-dashed text-sm" style={{ color: PAPER.muted, borderColor: PAPER.border }}>
          {lab(labels, "type_image")}
        </span>
      ) : (
        // eslint-disable-next-line @next/next/no-img-element -- an email image, shown as the email shows it
        <img src={`/api/public/files/${block.fileId}`} alt={block.alt} className="mx-auto block h-auto max-w-full" style={{ width: block.width ?? 600 }} />
      );
    case "button":
      return (
        <span className="block text-center">
          <span
            className="inline-block rounded-md px-6 py-3 font-semibold"
            style={block.style === "primary" ? { background: PAPER.color, color: PAPER.surface } : { background: PAPER.surface, color: PAPER.color, border: `2px solid ${PAPER.color}` }}
          >
            {block.label || lab(labels, "empty_text")}
          </span>
        </span>
      );
    case "divider":
      return <span className="my-2 block h-px" style={{ background: PAPER.border }} />;
    case "spacer":
      return <span className="block rounded-sm border border-dashed border-transparent hover:border-current" style={{ height: block.height, color: PAPER.border }} />;
    case "product":
      return <CardPreview title={lab(labels, "type_product")} cta={block.ctaLabel} labels={labels} />;
    case "event":
      return <CardPreview title={lab(labels, "type_event")} cta={block.ctaLabel} labels={labels} />;
    case "webinar":
      return <CardPreview title={lab(labels, "type_webinar")} cta={block.ctaLabel} labels={labels} />;
    default:
      return null;
  }
}

export type BlockCanvasProps = {
  blocks: readonly Block[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onChange: (blocks: Block[]) => void;
  /** A palette block dropped on the canvas: before the top-level block `beforeId`, or at the end. */
  onInsert?: (type: BlockType, beforeId: string | null) => void;
  /** Block ids with an accessibility or card warning. */
  warnedIds: ReadonlySet<string>;
  labels: EditorLabels;
  disabled?: boolean;
  /** Width of the email: desktop 600 px or mobile 375 px (columns stack when they may). */
  width?: 600 | 375;
};

const hasDrag = (e: DragEvent, type: string) => Array.from(e.dataTransfer.types).includes(type);

function VisualBlock({ block, top, props }: { block: Block; top: boolean; props: BlockCanvasProps }) {
  const { labels, selectedId, onSelect, onChange, blocks, disabled } = props;
  const [over, setOver] = useState(false);
  const selected = selectedId === block.id;
  const move = (delta: -1 | 1) => onChange(moveBlock([...blocks], block.id, delta));
  const container = block.type === "columns" || block.type === "dynamic";

  function onKeyDown(e: KeyboardEvent<HTMLButtonElement>) {
    if (!e.altKey || disabled || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
    e.preventDefault();
    move(e.key === "ArrowUp" ? -1 : 1);
  }
  function onDragOver(e: DragEvent<HTMLDivElement>) {
    if (disabled) return;
    const moving = hasDrag(e, BLOCK_DRAG);
    if (!moving && !(top && hasDrag(e, PALETTE_DRAG))) return;
    e.preventDefault();
    e.stopPropagation();
    setOver(true);
  }
  function onDrop(e: DragEvent<HTMLDivElement>) {
    setOver(false);
    const id = e.dataTransfer.getData(BLOCK_DRAG);
    const type = e.dataTransfer.getData(PALETTE_DRAG);
    if (id) {
      e.preventDefault();
      e.stopPropagation();
      onChange(reorderBlock([...blocks], id, block.id));
    } else if (type && top && props.onInsert) {
      e.preventDefault();
      e.stopPropagation();
      props.onInsert(type as BlockType, block.id);
    }
  }

  const nested: { title: string; list: readonly Block[] }[] =
    block.type === "columns"
      ? block.columns.map((c, i) => ({ title: lab(labels, "column_n", { n: i + 1 }), list: c.blocks }))
      : block.type === "dynamic"
        ? [...block.variants.map((v, i) => ({ title: lab(labels, "variant_n", { n: i + 1 }), list: v.blocks })), { title: lab(labels, "fallback"), list: block.fallback }]
        : [];
  const stacked = block.type === "columns" && (block.stackOnMobile && props.width === 375);

  return (
    <div
      draggable={!disabled}
      onDragStart={(e) => {
        e.stopPropagation();
        e.dataTransfer.setData(BLOCK_DRAG, block.id);
        e.dataTransfer.effectAllowed = "move";
      }}
      onDragOver={onDragOver}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
      data-testid={`canvas-block-${block.type}`}
      className={cn(
        "group relative rounded-sm outline-offset-2",
        selected ? "outline-2 outline-primary [outline-style:solid]" : "hover:outline-1 hover:outline-dashed hover:outline-primary/60",
        over && "before:absolute before:-top-1 before:left-0 before:right-0 before:h-0.5 before:bg-primary",
        !disabled && "cursor-grab",
      )}
    >
      <button
        type="button"
        onClick={() => onSelect(block.id)}
        onKeyDown={onKeyDown}
        aria-pressed={selected}
        aria-label={`${lab(labels, `type_${block.type}`)}${container ? "" : `: ${summary(block, labels)}`}`}
        aria-keyshortcuts={disabled ? undefined : "Alt+ArrowUp Alt+ArrowDown"}
        data-block-id={block.id}
        className={cn("block w-full rounded-sm px-6 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring", container && "py-1")}
      >
        {container ? (
          <span className="flex items-center gap-2 text-xs" style={{ color: PAPER.muted }}>
            <Badge variant="secondary">{lab(labels, `type_${block.type}`)}</Badge>
            {summary(block, labels)}
          </span>
        ) : (
          <LeafPreview block={block} labels={labels} />
        )}
        {props.warnedIds.has(block.id) ? <Badge variant="destructive" className="mt-1">{lab(labels, "warning")}</Badge> : null}
      </button>
      {nested.length ? (
        <div className={cn("gap-2 px-2 pb-2", block.type === "columns" && !stacked ? "flex" : "grid")}>
          {nested.map((n, i) => (
            <div
              key={n.title}
              className={cn("min-w-0 rounded-sm border border-dashed p-1", block.type === "dynamic" && "bg-muted/20")}
              style={block.type === "columns" && !stacked ? { flexBasis: `${block.columns[i]?.width ?? 50}%` } : undefined}
            >
              <span className="block px-1 text-[10px] uppercase tracking-wide" style={{ color: PAPER.muted }}>
                {n.title}
              </span>
              {n.list.length ? (
                n.list.map((b) => <VisualBlock key={b.id} block={b} top={false} props={props} />)
              ) : (
                <span className="block px-1 py-2 text-xs italic" style={{ color: PAPER.muted }}>
                  {lab(labels, "empty_list")}
                </span>
              )}
            </div>
          ))}
        </div>
      ) : null}
      {selected && !disabled ? (
        <div className="absolute -top-3 right-1 z-10 flex gap-0.5 rounded-md border bg-background p-0.5 shadow-sm" data-testid="block-toolbar">
          <Button type="button" size="sm" variant="ghost" className="h-6 px-1.5" aria-label={lab(labels, "move_up")} onClick={() => move(-1)}>
            ↑
          </Button>
          <Button type="button" size="sm" variant="ghost" className="h-6 px-1.5" aria-label={lab(labels, "move_down")} onClick={() => move(1)}>
            ↓
          </Button>
          <Button type="button" size="sm" variant="ghost" className="h-6 px-1.5" aria-label={lab(labels, "remove")} onClick={() => onChange(removeBlock([...blocks], block.id))}>
            ✕
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The visual canvas: the open locale's blocks drawn as the email looks, on the email's paper at
 * desktop or mobile width. Press a block to edit it in the side panel; drag a block onto another
 * to move it there (within its own list), or use the toolbar or Alt+Arrow keys; drop a palette
 * block onto a top-level block to insert it before, or onto the end zone to append it.
 */
export function BlockCanvas(props: BlockCanvasProps) {
  const { labels, disabled, onInsert } = props;
  const [overEnd, setOverEnd] = useState(false);
  return (
    <div className="overflow-x-auto rounded-md p-3" style={{ background: PAPER.background }} data-testid="email-canvas">
      <div
        className="mx-auto grid gap-1 py-4 shadow-sm"
        style={{ width: props.width ?? 600, maxWidth: "100%", background: PAPER.surface, color: PAPER.text, fontFamily: PAPER.font, fontSize: 16, lineHeight: 1.5 }}
        role="group"
        aria-label={lab(labels, "canvas")}
      >
        {props.blocks.map((b) => (
          <VisualBlock key={b.id} block={b} top props={props} />
        ))}
        {!disabled && onInsert ? (
          <div
            onDragOver={(e) => {
              if (!hasDrag(e, PALETTE_DRAG)) return;
              e.preventDefault();
              setOverEnd(true);
            }}
            onDragLeave={() => setOverEnd(false)}
            onDrop={(e) => {
              setOverEnd(false);
              const type = e.dataTransfer.getData(PALETTE_DRAG);
              if (!type) return;
              e.preventDefault();
              onInsert(type as BlockType, null);
            }}
            data-testid="canvas-drop-end"
            className={cn("mx-6 rounded-md border border-dashed p-4 text-center text-sm", overEnd ? "border-primary bg-primary/5" : "")}
            style={{ color: PAPER.muted }}
          >
            {props.blocks.length ? lab(labels, "drop_here") : lab(labels, "canvas_empty")}
          </div>
        ) : !props.blocks.length ? (
          <p className="p-6 text-center text-sm" style={{ color: PAPER.muted }}>
            {lab(labels, "canvas_empty")}
          </p>
        ) : null}
      </div>
    </div>
  );
}
