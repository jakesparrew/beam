"use client";
/**
 * Dynamic block editor (email spec rule 18): the ordered variant list, each with its condition
 * (`status` lead, customer or member from `v_person_status`, or an assessment outcome: a form
 * slug and the outcome keys that match) and its blocks, plus the fallback. The first matching
 * variant renders; no match renders the fallback (which may be empty). Blocks of a branch are
 * added here and edited by selecting them on the canvas.
 */
import { Button, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@beam/ui";
import type { BlockType, DynamicBlock, DynamicCondition } from "@beam/core/email";
import { lab, newBlock, type EditorLabels } from "./BlockCanvas";
import { BlockPalette, IN_DYNAMIC_TYPES } from "./BlockPalette";

type Branch = DynamicBlock["fallback"];

export type DynamicBlockEditorProps = {
  block: DynamicBlock;
  onChange: (block: DynamicBlock) => void;
  labels: EditorLabels;
  disabled?: boolean;
};

const STATUSES = ["lead", "customer", "member"] as const;

function conditionKind(when: DynamicCondition): "status" | "assessment" {
  return "status" in when ? "status" : "assessment";
}

function ConditionEditor({ when, onChange, labels, disabled }: { when: DynamicCondition; onChange: (w: DynamicCondition) => void; labels: EditorLabels; disabled?: boolean }) {
  const kind = conditionKind(when);
  return (
    <div className="grid gap-2 sm:grid-cols-[10rem_1fr]">
      <Select
        value={kind}
        disabled={disabled}
        onValueChange={(v) => onChange(v === "status" ? { status: "member" } : { assessmentOutcome: { formSlug: "", outcomeKeys: [""] } })}
      >
        <SelectTrigger aria-label={lab(labels, "condition")}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="status">{lab(labels, "condition_status")}</SelectItem>
          <SelectItem value="assessment">{lab(labels, "condition_assessment")}</SelectItem>
        </SelectContent>
      </Select>
      {"status" in when ? (
        <Select value={when.status} disabled={disabled} onValueChange={(v) => onChange({ status: v as (typeof STATUSES)[number] })}>
          <SelectTrigger aria-label={lab(labels, "condition_status")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                {lab(labels, `persona_${s}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="grid gap-1 text-xs">
            <span>{lab(labels, "form_slug")}</span>
            <Input
              value={when.assessmentOutcome.formSlug}
              disabled={disabled}
              onChange={(e) => onChange({ assessmentOutcome: { ...when.assessmentOutcome, formSlug: e.target.value.trim() } })}
            />
          </label>
          <label className="grid gap-1 text-xs">
            <span>{lab(labels, "outcome_keys")}</span>
            <Input
              value={when.assessmentOutcome.outcomeKeys.join(", ")}
              disabled={disabled}
              onChange={(e) =>
                onChange({
                  assessmentOutcome: {
                    ...when.assessmentOutcome,
                    outcomeKeys: e.target.value
                      .split(",")
                      .map((k) => k.trim())
                      .filter(Boolean),
                  },
                })
              }
            />
          </label>
        </div>
      )}
    </div>
  );
}

export function DynamicBlockEditor({ block, onChange, labels, disabled }: DynamicBlockEditorProps) {
  const add = (branch: Branch, type: BlockType): Branch => [...branch, newBlock(type) as Branch[number]];
  const setVariant = (i: number, patch: Partial<DynamicBlock["variants"][number]>) =>
    onChange({ ...block, variants: block.variants.map((v, j) => (j === i ? { ...v, ...patch } : v)) });
  const move = (i: number, delta: -1 | 1) => {
    const j = i + delta;
    if (j < 0 || j >= block.variants.length) return;
    const variants = [...block.variants];
    [variants[i], variants[j]] = [variants[j]!, variants[i]!];
    onChange({ ...block, variants });
  };
  return (
    <div className="grid gap-4" data-testid="dynamic-editor">
      <p className="text-xs text-muted-foreground">{lab(labels, "dynamic_help")}</p>
      <ol className="grid gap-3">
        {block.variants.map((v, i) => (
          <li key={i} className="grid gap-2 rounded-md border p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium">{lab(labels, "variant_n", { n: i + 1 })}</span>
              <div className="flex gap-1">
                <Button type="button" size="sm" variant="ghost" disabled={disabled || i === 0} aria-label={lab(labels, "move_up")} onClick={() => move(i, -1)}>
                  ↑
                </Button>
                <Button type="button" size="sm" variant="ghost" disabled={disabled || i === block.variants.length - 1} aria-label={lab(labels, "move_down")} onClick={() => move(i, 1)}>
                  ↓
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={disabled || block.variants.length === 1}
                  aria-label={lab(labels, "remove_variant")}
                  onClick={() => onChange({ ...block, variants: block.variants.filter((_x, j) => j !== i) })}
                >
                  ✕
                </Button>
              </div>
            </div>
            <ConditionEditor when={v.when} onChange={(when) => setVariant(i, { when })} labels={labels} disabled={disabled} />
            <span className="text-xs text-muted-foreground">{lab(labels, "blocks_count", { count: v.blocks.length })}</span>
            <BlockPalette compact types={IN_DYNAMIC_TYPES} labels={labels} disabled={disabled} onAdd={(type) => setVariant(i, { blocks: add(v.blocks, type) })} />
          </li>
        ))}
      </ol>
      <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={() => onChange({ ...block, variants: [...block.variants, { when: { status: "customer" }, blocks: [] }] })}>
        + {lab(labels, "add_variant")}
      </Button>
      <div className="grid gap-2 rounded-md border border-dashed p-3">
        <span className="text-sm font-medium">{lab(labels, "fallback")}</span>
        <span className="text-xs text-muted-foreground">{lab(labels, "blocks_count", { count: block.fallback.length })}</span>
        <BlockPalette compact types={IN_DYNAMIC_TYPES} labels={labels} disabled={disabled} onAdd={(type) => onChange({ ...block, fallback: add(block.fallback, type) })} />
      </div>
    </div>
  );
}
