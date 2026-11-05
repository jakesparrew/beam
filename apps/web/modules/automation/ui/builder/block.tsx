"use client";
/**
 * One block of the visual builder's canvas (automation-P10, spec 5): the block's name, its step
 * key and a one-line summary, a validation badge, the "skipped when" badge of a step's `unless`,
 * and the accessible alternatives to dragging: "Move up" / "Move down" buttons and Alt+Arrow
 * keys on the focused block. Pressing the block selects it for the side panel. Every string
 * arrives through `l`.
 */
import type { DragEvent, KeyboardEvent } from "react";
import { Badge, Button } from "@beam/ui";
import type { BuilderBlock, BuilderNode } from "../../../../../../packages/core/src/automation/builder";
import { blockOfStepType } from "../../../../../../packages/core/src/automation/builder";
import { predicateOf, type CondJson } from "../condition-builder";
import { fill, type Labels, str } from "../outcome-badge";

/** The block of a node (Condition and Branch are both `condition` steps). */
export function blockOf(node: BuilderNode): BuilderBlock {
  if (node.kind !== "step") return node.kind;
  return blockOfStepType(node.step.type);
}

const short = (s: string, n = 60) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The one-line summary of a node's settings. */
export function blockSummary(node: BuilderNode, l: Labels): string {
  const s = node.step as unknown as Record<string, unknown>;
  if (node.kind !== "step") {
    const p = predicateOf((s.if ?? {}) as CondJson);
    return p ? (l[`editor.predicate.${p}`] ?? p) : "";
  }
  switch (node.step.type) {
    case "wait":
      return `${str(s.minutes, 0)} min`;
    case "email":
      return str(s.template);
    case "task":
      return short(str(s.title));
    case "tag":
      return `+ ${str(s.tag)}`;
    case "untag":
      return `− ${str(s.tag)}`;
    case "status_override":
      return s.value === null ? (l["editor.status_value_none"] ?? "") : (l[`editor.person_status.${str(s.value)}`] ?? str(s.value));
    case "enrol":
      return `${l["editor.step_type.enrol"] ?? ""}: ${str(s.automation)}`;
    case "exit":
      return `${l["editor.step_type.exit"] ?? ""}: ${s.automation === undefined ? (l["editor.exit_target_self"] ?? "") : str(s.automation)}`;
    case "notify_slack":
      return short(str(s.text));
    case "set_field":
      return l[`editor.channel.${str(s.value)}`] ?? str(s.value);
    case "webhook":
      return short(str(s.url));
  }
}

const ACCENT: Record<BuilderBlock, string> = {
  trigger: "border-l-primary",
  condition: "border-l-amber-500",
  branch: "border-l-amber-500",
  delay: "border-l-slate-400",
  email: "border-l-sky-500",
  task: "border-l-violet-500",
  tag: "border-l-emerald-500",
  status: "border-l-emerald-500",
  sequence: "border-l-indigo-500",
  notify: "border-l-pink-500",
  field: "border-l-emerald-500",
  webhook: "border-l-orange-500",
};

export function BlockCard({
  block,
  title,
  stepKey,
  summary,
  issueCount,
  skipWhen,
  selected,
  readOnly,
  canMoveUp,
  canMoveDown,
  onSelect,
  onMove,
  onRemove,
  onDragStart,
  onDragOver,
  onDrop,
  l,
}: {
  block: BuilderBlock;
  title: string;
  stepKey?: string;
  summary: string;
  issueCount: number;
  skipWhen?: boolean;
  selected: boolean;
  readOnly: boolean;
  canMoveUp?: boolean;
  canMoveDown?: boolean;
  onSelect: () => void;
  onMove?: (by: -1 | 1) => void;
  onRemove?: () => void;
  onDragStart?: (e: DragEvent<HTMLDivElement>) => void;
  onDragOver?: (e: DragEvent<HTMLDivElement>) => void;
  onDrop?: (e: DragEvent<HTMLDivElement>) => void;
  l: Labels;
}) {
  const movable = !readOnly && !!onMove;
  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.target !== e.currentTarget) return;
    if (e.altKey && movable && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      if (e.key === "ArrowUp" && canMoveUp) onMove(-1);
      if (e.key === "ArrowDown" && canMoveDown) onMove(1);
      return;
    }
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onSelect();
    }
  }
  return (
    <div
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      aria-label={`${fill(l["builder.blocks_label"], { name: title })}${stepKey ? ` ${stepKey}` : ""}`}
      aria-keyshortcuts={movable ? "Alt+ArrowUp Alt+ArrowDown" : undefined}
      draggable={movable}
      onClick={onSelect}
      onKeyDown={onKeyDown}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      data-testid={`builder-block-${stepKey ?? block}`}
      data-block={block}
      className={`grid w-full gap-1 rounded-md border border-l-4 bg-card p-3 text-left text-sm shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring ${ACCENT[block]} ${selected ? "ring-2 ring-primary" : ""} ${movable ? "cursor-grab" : "cursor-pointer"}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-semibold">{title}</span>
        <span className="flex flex-wrap items-center gap-1">
          {skipWhen ? <Badge variant="outline">{l["builder.skip_when"]}</Badge> : null}
          {issueCount > 0 ? (
            <Badge variant="destructive" data-testid="builder-block-issues">
              {fill(l["builder.issues_badge"], { count: issueCount })}
            </Badge>
          ) : null}
        </span>
      </div>
      {stepKey ? <span className="font-mono text-xs text-muted-foreground">{stepKey}</span> : null}
      {summary ? <span className="text-muted-foreground">{summary}</span> : null}
      {movable || (!readOnly && onRemove) ? (
        <div className="flex flex-wrap gap-1" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
          {movable ? (
            <>
              <Button type="button" variant="ghost" size="sm" disabled={!canMoveUp} onClick={() => onMove(-1)} aria-label={`${l["builder.move_up"]} ${stepKey ?? ""}`.trim()}>
                {l["builder.move_up"]}
              </Button>
              <Button type="button" variant="ghost" size="sm" disabled={!canMoveDown} onClick={() => onMove(1)} aria-label={`${l["builder.move_down"]} ${stepKey ?? ""}`.trim()}>
                {l["builder.move_down"]}
              </Button>
            </>
          ) : null}
          {!readOnly && onRemove ? (
            <Button type="button" variant="ghost" size="sm" onClick={onRemove} aria-label={`${l["builder.remove"]} ${stepKey ?? ""}`.trim()}>
              {l["builder.remove"]}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
