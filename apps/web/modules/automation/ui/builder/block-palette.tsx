"use client";
/**
 * The builder's palette (automation-P10): the eleven blocks that can be added after the Trigger
 * (blueprint 51). Each one is dragged onto the canvas (native drag and drop) or pressed to add it
 * at the end of the selected lane, which the palette names.
 */
import { BUILDER_BLOCKS, type BuilderBlock } from "@beam/core/automation";
import { fill, type Labels } from "../outcome-badge";
import { BLOCK_MIME } from "./branch-lane";

export const PALETTE_BLOCKS = BUILDER_BLOCKS.filter((b): b is Exclude<BuilderBlock, "trigger"> => b !== "trigger");

export function BlockPalette({ onAdd, laneName, disabled, l }: { onAdd: (block: BuilderBlock) => void; laneName: string; disabled: boolean; l: Labels }) {
  return (
    <section aria-labelledby="builder-palette-title" className="grid content-start gap-2" data-testid="builder-palette">
      <h2 id="builder-palette-title" className="text-sm font-semibold">
        {l["builder.palette_title"]}
      </h2>
      <p className="text-xs text-muted-foreground">{l["builder.palette_hint"]}</p>
      <p className="text-xs" data-testid="builder-active-lane">
        {fill(l["builder.adding_to"], { lane: laneName })}
      </p>
      <ul className="grid gap-1">
        {PALETTE_BLOCKS.map((b) => (
          <li key={b}>
            <button
              type="button"
              draggable={!disabled}
              disabled={disabled}
              onClick={() => onAdd(b)}
              onDragStart={(e) => {
                e.dataTransfer.setData(BLOCK_MIME, b);
                e.dataTransfer.effectAllowed = "copy";
              }}
              title={l[`builder.block_help.${b}`]}
              data-testid={`builder-palette-${b}`}
              className="grid w-full gap-0.5 rounded-md border bg-card px-3 py-2 text-left text-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            >
              <span className="font-medium">{l[`builder.block.${b}`] ?? b}</span>
              <span className="text-xs text-muted-foreground">{l[`builder.block_help.${b}`]}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
