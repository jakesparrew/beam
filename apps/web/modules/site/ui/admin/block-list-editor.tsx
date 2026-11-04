"use client";
/**
 * The block list of one locale (site spec section 5 editor): add, edit, move up and down,
 * duplicate, delete, and "copy blocks from nl-BE" (copies with new ids). Hero is offered only as
 * the first block (rule 18); the list holds at most 60 blocks (rule 5). Invalid blocks are marked
 * with the `BlockSchema` message so the editor can fix them before saving.
 */
import { useState } from "react";
import { Button } from "@beam/ui";
import { BLOCK_TYPES, BlockSchema, MAX_BLOCKS, type Block, type BlockType } from "@beam/core/site";
import type { Locale } from "@beam/core/i18n";
import type { EditorPickers, SiteAdminLabels } from "../../queries/admin";
import { BlockForm, cloneBlock, newBlock } from "./block-forms";
import { lbl, selectClass } from "./pickers";
import type { RichTextLabels } from "./rich-text-editor";

export type BlockListEditorProps = {
  locale: Locale;
  blocks: Block[];
  onChange: (blocks: Block[]) => void;
  /** nl-BE blocks, for "copy blocks from nl-BE" on the other locales. */
  sourceBlocks?: Block[];
  isLegal: boolean;
  L: SiteAdminLabels;
  pickers: EditorPickers;
  rich: RichTextLabels;
  /** Block ids with publish issues (marked in the list). */
  issueBlockIds: Set<string>;
};

export function BlockListEditor({ locale, blocks, onChange, sourceBlocks, isLegal, L, pickers, rich, issueBlockIds }: BlockListEditorProps) {
  const [adding, setAdding] = useState<BlockType>("rich_text");
  const [open, setOpen] = useState<string | null>(blocks[0]?.id ?? null);
  const types = BLOCK_TYPES.filter((t) => (t !== "legal_meta" || isLegal) && (t !== "hero" || blocks.length === 0));
  const move = (i: number, d: -1 | 1) => {
    const next = [...blocks];
    const j = i + d;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j]!, next[i]!];
    onChange(next);
  };
  return (
    <div className="grid gap-3" data-locale={locale}>
      {sourceBlocks && locale !== "nl-BE" && sourceBlocks.length ? (
        <Button type="button" variant="outline" size="sm" className="justify-self-start" onClick={() => onChange(sourceBlocks.map(cloneBlock))}>
          {lbl(L, "editor.copyFromNl")}
        </Button>
      ) : null}
      <ol className="grid gap-2">
        {blocks.map((b, i) => {
          const parsed = BlockSchema.safeParse(b);
          const invalid = !parsed.success;
          const flagged = invalid || issueBlockIds.has(b.id);
          return (
            <li key={b.id} className={`rounded-md border ${flagged ? "border-destructive" : ""}`}>
              <div className="flex flex-wrap items-center justify-between gap-2 p-2">
                <button type="button" className="text-left font-medium" aria-expanded={open === b.id} onClick={() => setOpen(open === b.id ? null : b.id)}>
                  {i + 1}. {lbl(L, `block.${b.type}.name`)}
                  {flagged ? <span className="ml-2 text-xs text-destructive">{lbl(L, "issue.block_invalid")}</span> : null}
                </button>
                <div className="flex flex-wrap gap-1">
                  <Button type="button" size="sm" variant="ghost" onClick={() => move(i, -1)} disabled={i === 0 || (blocks[i - 1]?.type === "hero")}>
                    {lbl(L, "editor.moveUp")}
                  </Button>
                  <Button type="button" size="sm" variant="ghost" onClick={() => move(i, 1)} disabled={i === blocks.length - 1 || b.type === "hero"}>
                    {lbl(L, "editor.moveDown")}
                  </Button>
                  <Button type="button" size="sm" variant="ghost" disabled={b.type === "hero" || blocks.length >= MAX_BLOCKS} onClick={() => onChange([...blocks.slice(0, i + 1), cloneBlock(b), ...blocks.slice(i + 1)])}>
                    {lbl(L, "editor.duplicate")}
                  </Button>
                  <Button type="button" size="sm" variant="ghost" className="text-destructive" onClick={() => onChange(blocks.filter((x) => x.id !== b.id))}>
                    {lbl(L, "editor.delete")}
                  </Button>
                </div>
              </div>
              {open === b.id ? (
                <div className="border-t p-3">
                  <BlockForm block={b} onChange={(nb) => onChange(blocks.map((x) => (x.id === b.id ? nb : x)))} L={L} pickers={pickers} rich={rich} />
                  {invalid ? (
                    <ul className="mt-2 text-xs text-destructive">
                      {parsed.error.issues.slice(0, 5).map((iss, k) => (
                        <li key={k}>
                          {iss.path.join(".")}: {iss.message}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ) : null}
            </li>
          );
        })}
      </ol>
      {blocks.length < MAX_BLOCKS ? (
        <div className="flex flex-wrap items-end gap-2">
          <select aria-label={lbl(L, "editor.addBlock")} className={`${selectClass} w-auto`} value={types.includes(adding) ? adding : "rich_text"} onChange={(e) => setAdding(e.target.value as BlockType)}>
            {types.map((t) => (
              <option key={t} value={t}>
                {lbl(L, `block.${t}.name`)}
              </option>
            ))}
          </select>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              const b = newBlock(types.includes(adding) ? adding : "rich_text");
              onChange([...blocks, b]);
              setOpen(b.id);
            }}
          >
            {lbl(L, "editor.addBlock")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
