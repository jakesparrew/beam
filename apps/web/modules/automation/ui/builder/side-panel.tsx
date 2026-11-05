"use client";
/**
 * The builder's side panel (automation-P10, spec 5): the settings of the selected block with the
 * same field forms as the V1 editor. The Trigger block shows the trigger, timing, audience,
 * re-entry and exit cards; an action block shows the editor's step form (its "Add step" picker
 * adds the new block right after this one); a Condition or Branch block shows its step key, the
 * condition builder and, for an empty lane, where that lane goes.
 */
import { Input } from "@beam/ui";
import type { BranchLane, BuilderNode, BuilderTrigger } from "../../../../../../packages/core/src/automation/builder";
import { ConditionBuilder, selectClass, type EditorOptions, type Json } from "../condition-builder";
import { fill, type Labels } from "../outcome-badge";
import { Field, StepForms, type IssueView, type StepJson } from "../step-forms";
import { AudienceCard, IssueList, ReEntryExitCard, TimingCard, TriggerCard } from "../trigger-card";

type Obj = { [k: string]: Json };

export type SidePanelProps = {
  l: Labels;
  options: EditorOptions;
  readOnly: boolean;
  /** Issues of the selected block, with step paths as `steps.0.<field>`. */
  issues: IssueView[];
};

export function TriggerPanel({ trigger, onChange, triggerIssues, ...p }: SidePanelProps & { trigger: BuilderTrigger; onChange: (patch: Obj, drop?: string[]) => void; triggerIssues: IssueView[] }) {
  const cardProps = { def: trigger as unknown as Obj, set: onChange, l: p.l, options: p.options, issues: triggerIssues, disabled: p.readOnly };
  return (
    <div className="grid gap-4" data-testid="builder-panel-trigger">
      <p className="text-xs text-muted-foreground">{p.l["builder.block_help.trigger"]}</p>
      <TriggerCard {...cardProps} />
      <TimingCard {...cardProps} />
      <AudienceCard {...cardProps} />
      <ReEntryExitCard {...cardProps} />
    </div>
  );
}

function LaneTarget({ which, lane, laterKeys, onChange, l, disabled }: { which: "then" | "else"; lane: BranchLane; laterKeys: string[]; onChange: (lane: BranchLane) => void; l: Labels; disabled: boolean }) {
  const value = lane.end ? "end" : lane.goto ? `goto:${lane.goto}` : "continue";
  const laneName = l[`builder.lane_${which}`] ?? which;
  return (
    <Field label={`${laneName}: ${l["builder.lane_when_empty"] ?? ""}`}>
      {(id) => (
        <select
          id={id}
          className={selectClass}
          disabled={disabled}
          value={value}
          data-testid={`builder-lane-target-${which}`}
          onChange={(e) => {
            const v = e.target.value;
            if (v === "end") onChange({ blocks: [], end: true });
            else if (v.startsWith("goto:")) onChange({ blocks: [], goto: v.slice(5) });
            else onChange({ blocks: [] });
          }}
        >
          <option value="continue">{l["builder.lane_option_continue"]}</option>
          <option value="end">{l["builder.lane_option_end"]}</option>
          {lane.goto && !laterKeys.includes(lane.goto) ? <option value={`goto:${lane.goto}`}>{fill(l["builder.lane_option_goto"], { key: lane.goto })}</option> : null}
          {laterKeys.map((k) => (
            <option key={k} value={`goto:${k}`}>
              {fill(l["builder.lane_option_goto"], { key: k })}
            </option>
          ))}
        </select>
      )}
    </Field>
  );
}

export function NodePanel({
  node,
  onChange,
  onInsertAfter,
  onRemove,
  laterKeys,
  allKeys,
  ...p
}: SidePanelProps & {
  node: BuilderNode;
  onChange: (node: BuilderNode) => void;
  onInsertAfter: (step: StepJson) => void;
  onRemove: () => void;
  /** Step keys after this block's lanes (targets a `goto` may name). */
  laterKeys: string[];
  allKeys: string[];
}) {
  const { l, options, readOnly, issues } = p;
  if (node.kind === "step") {
    return (
      <div className="grid gap-2" data-testid="builder-panel-step">
        <p className="text-xs text-muted-foreground">{l[`editor.step_help.${node.step.type}`]}</p>
        <StepForms
          steps={[node.step]}
          onChange={(steps) => {
            if (steps.length === 0) return onRemove();
            const [first, ...added] = steps;
            onChange({ ...node, step: first as unknown as typeof node.step });
            for (const s of added) onInsertAfter(s);
          }}
          l={l}
          options={options}
          issues={issues}
          disabled={readOnly}
        />
      </div>
    );
  }
  const on = (field: string) => issues.filter((i) => i.path === `steps.0.${field}` || i.path.startsWith(`steps.0.${field}.`));
  const setStep = (patch: Record<string, unknown>) => onChange({ ...node, step: { ...node.step, ...patch } });
  return (
    <fieldset disabled={readOnly} className="grid gap-3" data-testid="builder-panel-condition">
      <p className="text-xs text-muted-foreground">{l[`builder.block_help.${node.kind}`]}</p>
      <IssueList issues={issues.filter((i) => i.path === "steps.0" || i.path === "steps")} />
      <Field label={l["editor.step_key"] ?? ""} hint={l["editor.step_key_hint"]} issues={on("key")}>
        {(id, d) => <Input id={id} aria-describedby={d} value={node.step.key} onChange={(e) => setStep({ key: e.target.value })} data-testid="builder-step-key" />}
      </Field>
      <div className="grid gap-1">
        <span className="text-sm font-medium">{node.kind === "condition" ? l["builder.condition_if"] : l["builder.branch_if"]}</span>
        <ConditionBuilder value={node.step.if} onChange={(c) => setStep({ if: c })} l={l} options={options} stepKeys={allKeys} />
        <IssueList issues={on("if")} />
      </div>
      {node.kind === "branch"
        ? (["then", "else"] as const).map((which) =>
            node[which].blocks.length === 0 ? (
              <LaneTarget key={which} which={which} lane={node[which]} laterKeys={laterKeys} l={l} disabled={readOnly} onChange={(lane) => onChange({ ...node, [which]: lane })} />
            ) : null,
          )
        : null}
      <IssueList issues={[...on("then"), ...on("else")]} />
    </fieldset>
  );
}
