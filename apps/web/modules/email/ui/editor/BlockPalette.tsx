"use client";
/**
 * The block palette (email spec rule 16): one button per block type. The top level offers every
 * type; a `columns` column offers leaf blocks only and a `dynamic` branch leaf blocks and
 * `columns` (rule 17: no columns in columns, no dynamic in anything).
 */
import { Button } from "@beam/ui";
import { BLOCK_TYPES, type BlockType } from "@beam/core/email";
import { lab, type EditorLabels } from "./BlockCanvas";

export const LEAF_TYPES: readonly BlockType[] = BLOCK_TYPES.filter((t) => t !== "columns" && t !== "dynamic");
export const IN_DYNAMIC_TYPES: readonly BlockType[] = BLOCK_TYPES.filter((t) => t !== "dynamic");

export type BlockPaletteProps = {
  onAdd: (type: BlockType) => void;
  types?: readonly BlockType[];
  labels: EditorLabels;
  disabled?: boolean;
  /** Compact (inline in a nested list) or the full left pane. */
  compact?: boolean;
};

export function BlockPalette({ onAdd, types = BLOCK_TYPES, labels, disabled, compact }: BlockPaletteProps) {
  return (
    <div className={compact ? "flex flex-wrap gap-1" : "grid gap-2"} role="group" aria-label={lab(labels, "palette")}>
      {compact ? null : <h2 className="text-sm font-semibold">{lab(labels, "palette")}</h2>}
      {types.map((type) => (
        <Button key={type} type="button" size="sm" variant={compact ? "outline" : "secondary"} disabled={disabled} onClick={() => onAdd(type)} data-block-type={type} className={compact ? "" : "justify-start"}>
          + {lab(labels, `type_${type}`)}
        </Button>
      ))}
    </div>
  );
}
