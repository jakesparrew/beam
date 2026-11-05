"use client";
/**
 * A lane of the builder's canvas (automation-P10): its blocks top to bottom, a Branch block with
 * its "Yes" and "No" lanes side by side (recursively), and a "+" at the end of every lane that
 * makes it the lane new blocks go to and accepts a dropped palette block. Blocks are reordered
 * by native drag and drop within their own lane only; the Move buttons and Alt+Arrow keys of
 * `BlockCard` do the same without a pointer. State lives in the canvas and arrives as props.
 */
import type { DragEvent } from "react";
import type { BranchLane, BuilderBlock, BuilderNode, LanePath } from "../../../../../../packages/core/src/automation/builder";
import { fill, type Labels } from "../outcome-badge";
import { BlockCard, blockOf, blockSummary } from "./block";

export const NODE_MIME = "application/x-beam-builder-node";
export const BLOCK_MIME = "application/x-beam-builder-block";

/** A stable text key of a lane path (`main` for the main flow). */
export const laneKey = (path: LanePath): string => (path.length === 0 ? "main" : path.map((p) => `${p.id}.${p.lane}`).join("/"));

export type CanvasApi = {
  l: Labels;
  readOnly: boolean;
  selectedId: string | null;
  activeLane: string;
  issueCounts: Record<string, number>;
  onSelect: (id: string) => void;
  onMove: (path: LanePath, from: number, to: number) => void;
  onRemove: (id: string) => void;
  onInsert: (path: LanePath, index: number, block: BuilderBlock) => void;
  onActivateLane: (path: LanePath) => void;
};

const hasType = (e: DragEvent, mime: string) => Array.from(e.dataTransfer.types).includes(mime);

function dropTo(e: DragEvent, path: LanePath, index: number, api: CanvasApi): void {
  const key = laneKey(path);
  const block = e.dataTransfer.getData(BLOCK_MIME);
  if (block) {
    e.preventDefault();
    api.onInsert(path, index, block as BuilderBlock);
    return;
  }
  const raw = e.dataTransfer.getData(NODE_MIME);
  if (!raw) return;
  try {
    const from = JSON.parse(raw) as { lane: string; index: number };
    // Reordering stays within a lane (spec 5); a block dropped on another lane is ignored.
    if (from.lane !== key) return;
    e.preventDefault();
    api.onMove(path, from.index, index);
  } catch {
    // Not one of ours.
  }
}

function allowDrop(e: DragEvent, api: CanvasApi): void {
  if (api.readOnly) return;
  if (hasType(e, BLOCK_MIME) || hasType(e, NODE_MIME)) e.preventDefault();
}

/** True when the lane's last block ends the journey both ways (the seeded "end branch"). */
function endsJourney(blocks: BuilderNode[]): boolean {
  const last = blocks[blocks.length - 1];
  return !!last && last.kind === "branch" && last.then.blocks.length === 0 && last.else.blocks.length === 0 && !!last.then.end && !!last.else.end;
}

function emptyLaneText(lane: BranchLane, l: Labels): string {
  if (lane.end) return l["builder.lane_end"] ?? "";
  if (lane.goto) return fill(l["builder.lane_goto"], { key: lane.goto });
  return l["builder.lane_continue"] ?? "";
}

export function Lane({ blocks, path, label, api }: { blocks: BuilderNode[]; path: LanePath; label: string; api: CanvasApi }) {
  const { l } = api;
  const key = laneKey(path);
  const active = api.activeLane === key;
  return (
    <ol className="grid gap-3" aria-label={label} data-lane={key}>
      {blocks.map((node, i) => {
        const block = blockOf(node);
        const stepUnless = node.kind === "step" && node.step.unless !== undefined;
        const card = (
          <BlockCard
            block={block}
            title={l[`builder.block.${block}`] ?? block}
            stepKey={node.step.key}
            summary={blockSummary(node, l)}
            issueCount={api.issueCounts[node.id] ?? 0}
            skipWhen={stepUnless}
            selected={api.selectedId === node.id}
            readOnly={api.readOnly}
            canMoveUp={i > 0}
            canMoveDown={i < blocks.length - 1}
            onSelect={() => api.onSelect(node.id)}
            onMove={(by) => api.onMove(path, i, i + by)}
            onRemove={() => api.onRemove(node.id)}
            onDragStart={(e) => {
              e.dataTransfer.setData(NODE_MIME, JSON.stringify({ lane: key, index: i }));
              e.dataTransfer.effectAllowed = "move";
            }}
            onDragOver={(e) => allowDrop(e, api)}
            onDrop={(e) => dropTo(e, path, i, api)}
            l={l}
          />
        );
        if (node.kind !== "branch") {
          return (
            <li key={node.id} className="grid gap-3">
              {card}
            </li>
          );
        }
        const thenPath: LanePath = [...path, { id: node.id, lane: "then" }];
        const elsePath: LanePath = [...path, { id: node.id, lane: "else" }];
        const fallsThrough = node.then.blocks.length > 0 && node.else.blocks.length > 0 && !endsJourney(node.then.blocks);
        return (
          <li key={node.id} className="grid gap-3">
            {card}
            <div className="grid gap-3 border-l-2 border-dashed border-amber-500/60 pl-3 md:grid-cols-2" data-testid={`builder-lanes-${node.step.key}`}>
              {(["then", "else"] as const).map((which) => {
                const lane = node[which];
                const lanePath = which === "then" ? thenPath : elsePath;
                const laneName = l[`builder.lane_${which}`] ?? which;
                return (
                  <section key={which} className="grid content-start gap-2 rounded-md bg-muted/40 p-2" data-testid={`builder-lane-${node.step.key}-${which}`}>
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{laneName}</h3>
                    <Lane blocks={lane.blocks} path={lanePath} label={fill(l["builder.lane_of"], { branch: node.step.key, lane: laneName })} api={api} />
                    {lane.blocks.length === 0 ? <p className="text-xs text-muted-foreground">{emptyLaneText(lane, l)}</p> : null}
                    {which === "then" && fallsThrough ? <p className="text-xs text-amber-700 dark:text-amber-400">{l["builder.lane_falls_through"]}</p> : null}
                  </section>
                );
              })}
            </div>
          </li>
        );
      })}
      {!api.readOnly ? (
        <li>
          <button
            type="button"
            onClick={() => api.onActivateLane(path)}
            onDragOver={(e) => allowDrop(e, api)}
            onDrop={(e) => dropTo(e, path, blocks.length, api)}
            aria-pressed={active}
            aria-label={`${l["builder.add_here"] ?? ""}: ${label}`}
            data-testid={`builder-add-${key}`}
            className={`flex h-9 w-full items-center justify-center rounded-md border border-dashed text-lg leading-none text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${active ? "border-primary text-primary" : ""}`}
          >
            <span aria-hidden="true">+</span>
          </button>
        </li>
      ) : null}
    </ol>
  );
}
