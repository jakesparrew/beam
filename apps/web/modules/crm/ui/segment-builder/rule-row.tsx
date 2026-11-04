"use client";
/**
 * One node of the segment rule tree (crm spec 4.6): a group (all / any of), a "not", or a leaf
 * rule (profile field, tag, consent, other segment, activity). Groups nest up to the compiler's
 * depth limit (4); the builder never offers a deeper group.
 */
import { SEGMENT_MAX_DEPTH, type SegmentRule } from "@beam/core/crm";
import { Button } from "@beam/ui";
import { EventRuleEditor, newEventRule } from "./event-rule";
import { FieldPicker, newFieldRule, selectClass, type Option, type SegmentBuilderLabels } from "./field-picker";

type Group = Extract<SegmentRule, { op: "and" | "or" }>;
type LeafType = "field" | "tag" | "consent" | "in_segment" | "event";

const isGroup = (r: SegmentRule): r is Group => "op" in r;

function newLeaf(type: LeafType, labels: SegmentBuilderLabels, segments: Option[]): SegmentRule {
  switch (type) {
    case "field":
      return newFieldRule(labels);
    case "tag":
      return { type: "tag", tagKey: labels.tags[0]?.value ?? "vip", has: true };
    case "consent":
      return { type: "consent", purpose: (labels.purposes[0]?.value ?? "newsletter") as Extract<SegmentRule, { type: "consent" }>["purpose"], granted: true };
    case "in_segment":
      return { type: "in_segment", segmentId: segments[0]?.value ?? "00000000-0000-4000-8000-000000000000" };
    case "event":
      return newEventRule();
  }
}

export function GroupEditor({
  group,
  onChange,
  onRemove,
  depth,
  labels,
  segments,
  path,
}: {
  group: Group;
  onChange: (group: Group) => void;
  onRemove?: () => void;
  depth: number;
  labels: SegmentBuilderLabels;
  segments: Option[];
  path: string;
}) {
  const b = labels.builder;
  const setChild = (i: number, rule: SegmentRule) => onChange({ ...group, rules: group.rules.map((r, j) => (j === i ? rule : r)) });
  const removeChild = (i: number) => onChange({ ...group, rules: group.rules.filter((_, j) => j !== i) });
  return (
    <fieldset className="grid gap-3 rounded-md border p-3" aria-label={group.op === "and" ? b.group_and : b.group_or}>
      <div className="flex flex-wrap items-center gap-2">
        <select aria-label={b.rules} className={selectClass} value={group.op} onChange={(e) => onChange({ ...group, op: e.target.value as Group["op"] })}>
          <option value="and">{b.group_and}</option>
          <option value="or">{b.group_or}</option>
        </select>
        {onRemove ? (
          <Button type="button" variant="ghost" size="sm" onClick={onRemove}>
            {b.remove}
          </Button>
        ) : null}
      </div>
      {group.rules.map((rule, i) => (
        <RuleRow
          key={`${path}.${i}`}
          rule={rule}
          depth={depth + 1}
          labels={labels}
          segments={segments}
          path={`${path}.${i}`}
          onChange={(r) => setChild(i, r)}
          onRemove={() => removeChild(i)}
        />
      ))}
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" size="sm" onClick={() => onChange({ ...group, rules: [...group.rules, newFieldRule(labels)] })}>
          {b.add_rule}
        </Button>
        {depth < SEGMENT_MAX_DEPTH ? (
          <Button type="button" variant="outline" size="sm" onClick={() => onChange({ ...group, rules: [...group.rules, { op: group.op === "and" ? "or" : "and", rules: [newFieldRule(labels)] }] })}>
            {b.add_group}
          </Button>
        ) : null}
      </div>
    </fieldset>
  );
}

export function RuleRow({
  rule,
  onChange,
  onRemove,
  depth,
  labels,
  segments,
  path,
}: {
  rule: SegmentRule;
  onChange: (rule: SegmentRule) => void;
  onRemove: () => void;
  depth: number;
  labels: SegmentBuilderLabels;
  segments: Option[];
  path: string;
}) {
  const b = labels.builder;
  if (isGroup(rule)) return <GroupEditor group={rule} onChange={onChange} onRemove={onRemove} depth={depth} labels={labels} segments={segments} path={path} />;

  // A "not" wraps one leaf; the checkbox toggles the wrapper.
  const negated = rule.type === "not";
  const inner: SegmentRule = rule.type === "not" ? rule.rule : rule;
  if (isGroup(inner)) {
    return (
      <div className="grid gap-2">
        <span className="text-sm font-medium">{b.not}</span>
        <GroupEditor group={inner} onChange={(g) => onChange({ type: "not", rule: g })} onRemove={onRemove} depth={depth} labels={labels} segments={segments} path={path} />
      </div>
    );
  }
  const leaf = inner as Exclude<SegmentRule, Group | { type: "not" }>;
  const wrap = (r: SegmentRule) => onChange(negated ? { type: "not", rule: r } : r);
  const typeLabel: Record<LeafType, string> = { field: b.rule_field ?? "", tag: b.rule_tag ?? "", consent: b.rule_consent ?? "", in_segment: b.rule_in_segment ?? "", event: b.rule_event ?? "" };

  return (
    <div className="flex flex-wrap items-start gap-2 rounded-md bg-muted/40 p-2">
      <label className="flex items-center gap-1 pt-2 text-sm">
        <input type="checkbox" checked={negated} onChange={(e) => onChange(e.target.checked ? { type: "not", rule: leaf } : leaf)} />
        {b.not}
      </label>
      <select aria-label={b.rules} className={selectClass} value={leaf.type} onChange={(e) => wrap(newLeaf(e.target.value as LeafType, labels, segments))}>
        {(Object.keys(typeLabel) as LeafType[]).map((t) => (
          <option key={t} value={t}>
            {typeLabel[t]}
          </option>
        ))}
      </select>
      <div className="min-w-0 flex-1">
        <LeafEditor rule={leaf} onChange={wrap} labels={labels} segments={segments} path={path} />
      </div>
      <Button type="button" variant="ghost" size="sm" onClick={onRemove}>
        {b.remove}
      </Button>
    </div>
  );
}

function LeafEditor({
  rule,
  onChange,
  labels,
  segments,
  path,
}: {
  rule: Exclude<SegmentRule, Group | { type: "not" }>;
  onChange: (rule: SegmentRule) => void;
  labels: SegmentBuilderLabels;
  segments: Option[];
  path: string;
}) {
  const b = labels.builder;
  switch (rule.type) {
    case "field":
      return <FieldPicker rule={rule} onChange={onChange} labels={labels} idPrefix={path} />;
    case "event":
      return <EventRuleEditor rule={rule} onChange={onChange} labels={labels} />;
    case "tag":
      return (
        <div className="flex flex-wrap gap-2">
          <select aria-label={b.rule_tag} className={selectClass} value={String(rule.has)} onChange={(e) => onChange({ ...rule, has: e.target.value === "true" })}>
            <option value="true">{b.tag_has}</option>
            <option value="false">{b.tag_has_not}</option>
          </select>
          <select aria-label={b.rule_tag} className={selectClass} value={rule.tagKey} onChange={(e) => onChange({ ...rule, tagKey: e.target.value })}>
            {labels.tags.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </div>
      );
    case "consent":
      return (
        <div className="flex flex-wrap gap-2">
          <select aria-label={b.rule_consent} className={selectClass} value={String(rule.granted)} onChange={(e) => onChange({ ...rule, granted: e.target.value === "true" })}>
            <option value="true">{b.consent_granted}</option>
            <option value="false">{b.consent_not_granted}</option>
          </select>
          <select aria-label={b.rule_consent} className={selectClass} value={rule.purpose} onChange={(e) => onChange({ ...rule, purpose: e.target.value as typeof rule.purpose })}>
            {labels.purposes.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </div>
      );
    case "in_segment":
      return (
        <div className="flex flex-wrap gap-2">
          <select aria-label={b.rule_in_segment} className={selectClass} value={String(rule.negate === true)} onChange={(e) => onChange({ ...rule, negate: e.target.value === "true" || undefined })}>
            <option value="false">{b.in_segment}</option>
            <option value="true">{b.not_in_segment}</option>
          </select>
          <select aria-label={b.rule_in_segment} className={selectClass} value={rule.segmentId} onChange={(e) => onChange({ ...rule, segmentId: e.target.value })}>
            {segments.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
      );
  }
}
