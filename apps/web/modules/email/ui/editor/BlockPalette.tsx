"use client";
/**
 * The block palette (email spec rule 16): one button per block type. The top level offers every
 * type; a `columns` column offers leaf blocks only and a `dynamic` branch leaf blocks and
 * `columns` (rule 17: no columns in columns, no dynamic in anything). The R2 `webinar` block
 * (email-P8) is a leaf block and sits next to `event` in the palette. The full palette's buttons
 * can also be dragged onto the visual canvas (native drag and drop).
 */
import { Button } from "@beam/ui";
import { BLOCK_TYPES, type BlockType } from "@beam/core/email";
import { lab, PALETTE_DRAG, type EditorLabels } from "./BlockCanvas";

/** Every block type in palette order: the card blocks together, layout and dynamic content last. */
export const PALETTE_TYPES: readonly BlockType[] = [
  ...BLOCK_TYPES.filter((t) => t !== "columns" && t !== "dynamic" && t !== "webinar" && t !== "event" && t !== "product"),
  "product",
  "event",
  "webinar",
  "columns",
  "dynamic",
];
export const LEAF_TYPES: readonly BlockType[] = PALETTE_TYPES.filter((t) => t !== "columns" && t !== "dynamic");
export const IN_DYNAMIC_TYPES: readonly BlockType[] = PALETTE_TYPES.filter((t) => t !== "dynamic");

export type BlockPaletteProps = {
  onAdd: (type: BlockType) => void;
  types?: readonly BlockType[];
  labels: EditorLabels;
  disabled?: boolean;
  /** Compact (inline in a nested list) or the full left pane. */
  compact?: boolean;
};

export function BlockPalette({ onAdd, types = PALETTE_TYPES, labels, disabled, compact }: BlockPaletteProps) {
  return (
    <div className={compact ? "flex flex-wrap gap-1" : "grid gap-2"} role="group" aria-label={lab(labels, "palette")} data-testid={compact ? "block-palette-inline" : "block-palette"}>
      {compact ? null : <h2 className="text-sm font-semibold">{lab(labels, "palette")}</h2>}
      {types.map((type) => (
        <Button
          key={type}
          type="button"
          size="sm"
          variant={compact ? "outline" : "secondary"}
          disabled={disabled}
          onClick={() => onAdd(type)}
          draggable={!compact && !disabled}
          onDragStart={(e) => {
            e.dataTransfer.setData(PALETTE_DRAG, type);
            e.dataTransfer.effectAllowed = "copy";
          }}
          data-block-type={type}
          className={compact ? "" : "cursor-grab justify-start"}
        >
          + {lab(labels, `type_${type}`)}
        </Button>
      ))}
    </div>
  );
}
