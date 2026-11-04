"use client";
/**
 * The condition builder of the step editor (automation spec 5): `all` / `any` / `not` groups
 * around the leaf predicates of the definition format (2.8), each with its own small form, label
 * and help text from `automation.editor.predicate*`. It edits plain JSON (the draft may hold
 * values the parser rejects; the issue list beside the field says why). Keyboard: every control
 * is a native input, select or button.
 */
import { useId, useState } from "react";
import { Button, Input, Textarea } from "@beam/ui";
import { CONDITION_PREDICATES, type ConditionPredicate } from "@beam/core/automation";
import type { Labels } from "./outcome-badge";

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type CondJson = { [k: string]: Json };

export type EditorOptions = {
  tags: string[];
  segments: { id: string; name: string }[];
  eventKinds: string[];
  templates: { slug: string; name: string; kind: string; purpose: string | null; locales: string[] }[];
  automations: { slug: string; name: string }[];
  roles: string[];
};

const PERSON_STATUSES = ["lead", "customer", "member"] as const;
const BOOKING_KINDS = ["day", "night", "event"] as const;
const BOOKING_STATUSES = ["attended", "no_show", "confirmed", "cancelled"] as const;
const CREDIT_KINDS = ["day", "night", "euro", "{{trigger.data.credit_kind}}"] as const;

export const selectClass = "h-9 w-full rounded-md border border-input bg-background px-3 text-sm";

/** The value a predicate starts with when chosen in the type picker. */
export function defaultCondition(p: ConditionPredicate, o: Pick<EditorOptions, "tags" | "segments" | "eventKinds" | "templates">): CondJson {
  switch (p) {
    case "all":
    case "any":
      return { [p]: [{ has_active_membership: true }] };
    case "not":
      return { not: { has_active_membership: true } };
    case "has_future_booking":
    case "has_active_membership":
    case "membership_cancelling":
    case "processing_restricted":
      return { [p]: true };
    case "status_in":
      return { status_in: ["customer"] };
    case "has_tag":
      return { has_tag: o.tags[0] ?? "" };
    case "in_segment":
      return { in_segment: o.segments[0]?.id ?? "" };
    case "has_other_active_grant":
      return { has_other_active_grant: { credit_kind: "day" } };
    case "form_completed":
      return { form_completed: { slug: "" } };
    case "form_available":
      return { form_available: "" };
    case "event_since_enrolment":
      return { event_since_enrolment: o.eventKinds[0] ?? "" };
    case "booking_status_in":
      return { booking_status_in: ["attended"] };
    case "trigger":
      return { trigger: {} };
    case "task_open":
      return { task_open: "" };
    case "sent_within_days":
      return { sent_within_days: { template: o.templates[0]?.slug ?? "", days: 30 } };
  }
}

export function predicateOf(c: CondJson): ConditionPredicate | null {
  const k = Object.keys(c)[0];
  return k && (CONDITION_PREDICATES as readonly string[]).includes(k) ? (k as ConditionPredicate) : null;
}

const asObj = (v: Json | undefined): CondJson => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
const asArr = (v: Json | undefined): Json[] => (Array.isArray(v) ? v : []);
const optNumber = (raw: string): number | undefined => (raw.trim() === "" || Number.isNaN(Number(raw)) ? undefined : Number(raw));

function Checks({ name, values, all, labelOf, onChange }: { name: string; values: string[]; all: readonly string[]; labelOf: (v: string) => string; onChange: (v: string[]) => void }) {
  return (
    <fieldset className="flex flex-wrap gap-3">
      <legend className="sr-only">{name}</legend>
      {all.map((v) => (
        <label key={v} className="flex items-center gap-1 text-sm">
          <input type="checkbox" checked={values.includes(v)} onChange={(e) => onChange(e.target.checked ? [...values, v] : values.filter((x) => x !== v))} />
          {labelOf(v)}
        </label>
      ))}
    </fieldset>
  );
}

/** One condition (recursive for groups). */
export function ConditionBuilder({
  value,
  onChange,
  onRemove,
  l,
  options,
  stepKeys,
  depth = 0,
}: {
  value: CondJson;
  onChange: (c: CondJson) => void;
  onRemove?: () => void;
  l: Labels;
  options: EditorOptions;
  stepKeys: string[];
  depth?: number;
}) {
  const id = useId();
  const pred = predicateOf(value);
  const inner = pred ? value[pred] : undefined;
  const set = (v: Json) => onChange({ [pred!]: v });
  const [filterText, setFilterText] = useState(() => JSON.stringify(pred === "trigger" ? inner : {}, null, 2));

  return (
    <div className={`grid gap-2 rounded-md border p-3 ${depth > 0 ? "bg-muted/30" : ""}`} data-predicate={pred ?? "unknown"}>
      <div className="flex flex-wrap items-end gap-2">
        <div className="grid min-w-56 gap-1">
          <label htmlFor={`${id}-type`} className="text-sm font-medium">
            {l["editor.cond_type"]}
          </label>
          <select id={`${id}-type`} className={selectClass} value={pred ?? ""} onChange={(e) => onChange(defaultCondition(e.target.value as ConditionPredicate, options))} aria-describedby={`${id}-help`}>
            {pred ? null : <option value="">—</option>}
            {CONDITION_PREDICATES.filter((p) => depth < 3 || !["all", "any", "not"].includes(p)).map((p) => (
              <option key={p} value={p}>
                {l[`editor.predicate.${p}`] ?? p}
              </option>
            ))}
          </select>
        </div>
        {onRemove ? (
          <Button type="button" variant="ghost" size="sm" onClick={onRemove}>
            {l["common.remove"]}
          </Button>
        ) : null}
      </div>
      <p id={`${id}-help`} className="text-xs text-muted-foreground">
        {pred ? l[`editor.predicate_help.${pred}`] : null}
      </p>

      {pred === "all" || pred === "any" ? (
        <div className="grid gap-2" role="group" aria-label={l["editor.cond_group"]}>
          {asArr(inner).map((child, i) => (
            <ConditionBuilder
              key={i}
              value={asObj(child)}
              depth={depth + 1}
              l={l}
              options={options}
              stepKeys={stepKeys}
              onChange={(c) => set(asArr(inner).map((x, j) => (j === i ? c : x)))}
              onRemove={() => set(asArr(inner).filter((_, j) => j !== i))}
            />
          ))}
          <Button type="button" variant="outline" size="sm" className="w-fit" onClick={() => set([...asArr(inner), { has_active_membership: true }])}>
            {l["editor.cond_add"]}
          </Button>
        </div>
      ) : null}
      {pred === "not" ? <ConditionBuilder value={asObj(inner)} depth={depth + 1} l={l} options={options} stepKeys={stepKeys} onChange={(c) => set(c)} /> : null}

      {pred === "has_future_booking" ? (
        <div className="grid gap-2 sm:grid-cols-2">
          <select aria-label={l["editor.booking_kind_any"]} className={selectClass} value={String(asObj(inner).kind ?? "")} onChange={(e) => {
            const next = { ...asObj(inner), kind: e.target.value || undefined } as CondJson;
            if (!e.target.value) delete next.kind;
            set(Object.keys(next).length ? next : true);
          }}>
            <option value="">{l["editor.booking_kind_any"]}</option>
            {BOOKING_KINDS.map((k) => (
              <option key={k} value={k}>
                {l[`editor.booking_kind.${k}`]}
              </option>
            ))}
          </select>
          <Input type="number" min={1} aria-label={l["editor.within_days"]} placeholder={l["editor.within_days"]} value={String(asObj(inner).within_days ?? "")} onChange={(e) => {
            const next = { ...asObj(inner) } as CondJson;
            const n = optNumber(e.target.value);
            if (n === undefined) delete next.within_days;
            else next.within_days = n;
            set(Object.keys(next).length ? next : true);
          }} />
        </div>
      ) : null}
      {pred === "status_in" ? (
        <Checks name={l["editor.predicate.status_in"] ?? ""} values={asArr(inner).map(String)} all={PERSON_STATUSES} labelOf={(v) => l[`editor.person_status.${v}`] ?? v} onChange={set} />
      ) : null}
      {pred === "booking_status_in" ? (
        <Checks name={l["editor.predicate.booking_status_in"] ?? ""} values={asArr(inner).map(String)} all={BOOKING_STATUSES} labelOf={(v) => l[`editor.booking_status.${v}`] ?? v} onChange={set} />
      ) : null}
      {pred === "has_tag" ? (
        <select aria-label={l["editor.tag"]} className={selectClass} value={String(inner ?? "")} onChange={(e) => set(e.target.value)}>
          <option value="">{l["editor.tag_none"]}</option>
          {options.tags.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      ) : null}
      {pred === "in_segment" ? (
        <select aria-label={l["editor.segment"]} className={selectClass} value={String(inner ?? "")} onChange={(e) => set(e.target.value)}>
          <option value="">{l["editor.segment_none"]}</option>
          {options.segments.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      ) : null}
      {pred === "has_other_active_grant" ? (
        <select aria-label={l["editor.credit_kind"]} className={selectClass} value={String(asObj(inner).credit_kind ?? "day")} onChange={(e) => set({ credit_kind: e.target.value })}>
          {CREDIT_KINDS.map((k) => (
            <option key={k} value={k}>
              {k.startsWith("{{") ? l["editor.credit_kind_trigger"] : l[`editor.credit_kind.${k}`]}
            </option>
          ))}
        </select>
      ) : null}
      {pred === "form_completed" ? (
        <div className="grid gap-2 sm:grid-cols-2">
          <Input aria-label={l["editor.form_slug"]} placeholder={l["editor.form_slug"]} value={String(asObj(inner).slug ?? "")} onChange={(e) => set({ ...asObj(inner), slug: e.target.value })} />
          <Input type="number" min={1} aria-label={l["editor.within_days"]} placeholder={l["editor.within_days"]} value={String(asObj(inner).within_days ?? "")} onChange={(e) => {
            const next = { ...asObj(inner) };
            const n = optNumber(e.target.value);
            if (n === undefined) delete next.within_days;
            else next.within_days = n;
            set(next);
          }} />
        </div>
      ) : null}
      {pred === "form_available" ? <Input aria-label={l["editor.form_slug"]} value={String(inner ?? "")} onChange={(e) => set(e.target.value)} /> : null}
      {pred === "event_since_enrolment" ? (
        <select aria-label={l["editor.event_kind"]} className={selectClass} value={String(inner ?? "")} onChange={(e) => set(e.target.value)}>
          {options.eventKinds.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
      ) : null}
      {pred === "task_open" ? (
        <select aria-label={l["editor.step_ref"]} className={selectClass} value={String(inner ?? "")} onChange={(e) => set(e.target.value)}>
          <option value="">—</option>
          {stepKeys.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
      ) : null}
      {pred === "sent_within_days" ? (
        <div className="grid gap-2 sm:grid-cols-2">
          <select aria-label={l["editor.template"]} className={selectClass} value={String(asObj(inner).template ?? "")} onChange={(e) => set({ ...asObj(inner), template: e.target.value })}>
            <option value="">{l["editor.template_none"]}</option>
            {options.templates.map((t) => (
              <option key={t.slug} value={t.slug}>
                {t.slug}
              </option>
            ))}
          </select>
          <Input type="number" min={1} aria-label={l["editor.days"]} value={String(asObj(inner).days ?? "")} onChange={(e) => set({ ...asObj(inner), days: optNumber(e.target.value) ?? 0 })} />
        </div>
      ) : null}
      {pred === "trigger" ? (
        <Textarea
          aria-label={l["editor.filter_json"]}
          className="font-mono text-xs"
          rows={4}
          value={filterText}
          onChange={(e) => {
            setFilterText(e.target.value);
            try {
              set(JSON.parse(e.target.value) as Json);
            } catch {
              // Keep typing; the value is applied once it parses.
            }
          }}
        />
      ) : null}
    </div>
  );
}
