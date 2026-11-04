"use client";
/**
 * The definition cards above the steps (automation spec 5): the trigger card (event kinds from
 * the event registry with `where` rows path / operator / value, a segment, or manual), the timing
 * card (anchor and subject), the audience card, re-entry and the exit-on list. Each edits the
 * draft JSON in place and shows the validation issues of its paths.
 */
import { useId, useState } from "react";
import { Button, Card, CardContent, CardHeader, CardTitle, Input } from "@beam/ui";
import { selectClass, type EditorOptions, type Json } from "./condition-builder";
import { Field, type IssueView } from "./step-forms";
import type { Labels } from "./outcome-badge";

type Obj = { [k: string]: Json };
const asObj = (v: Json | undefined): Obj => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
const OPERATORS = ["eq", "ne", "in", "nin", "gt", "gte", "lt", "lte", "exists"] as const;
const LOCALES = ["nl-BE", "fr-BE", "en"] as const;
const STATUSES = ["lead", "customer", "member"] as const;

type Row = { path: string; op: (typeof OPERATORS)[number]; value: string };

function literalText(v: Json): string {
  if (Array.isArray(v)) return v.map((x) => literalText(x)).join(", ");
  return v === null ? "null" : String(v);
}

function parseLiteral(raw: string): Json {
  const t = raw.trim();
  if (t === "true") return true;
  if (t === "false") return false;
  if (t === "null") return null;
  if (t !== "" && !Number.isNaN(Number(t))) return Number(t);
  return t;
}

function rowsOf(filter: Obj): Row[] {
  const rows: Row[] = [];
  for (const [path, v] of Object.entries(filter)) {
    if (v === null || typeof v !== "object" || Array.isArray(v)) rows.push({ path, op: "eq", value: literalText(v) });
    else for (const [op, x] of Object.entries(v)) rows.push({ path, op: (OPERATORS as readonly string[]).includes(op) ? (op as Row["op"]) : "eq", value: literalText(x) });
  }
  return rows;
}

function filterOf(rows: Row[]): Obj {
  const out: Obj = {};
  for (const r of rows) {
    if (!r.path) continue;
    const value: Json = r.op === "in" || r.op === "nin" ? r.value.split(",").map((x) => parseLiteral(x)).filter((x) => x !== "") : r.op === "exists" ? r.value.trim() !== "false" : parseLiteral(r.value);
    const prev = out[r.path];
    const ops = prev && typeof prev === "object" && !Array.isArray(prev) ? prev : prev !== undefined ? { eq: prev } : {};
    out[r.path] = { ...ops, [r.op]: value };
  }
  return out;
}

/** `where` rows: path, operator (with its help text), value. */
export function WhereRows({ value, onChange, l, disabled }: { value: Obj | undefined; onChange: (f: Obj | undefined) => void; l: Labels; disabled: boolean }) {
  const [rows, setRows] = useState<Row[]>(() => rowsOf(value ?? {}));
  const update = (next: Row[]) => {
    setRows(next);
    const f = filterOf(next);
    onChange(Object.keys(f).length ? f : undefined);
  };
  return (
    <div className="grid gap-2" role="group" aria-label={l["editor.where"]}>
      <p className="text-xs text-muted-foreground">{l["editor.where_hint"]}</p>
      {rows.map((r, i) => (
        <div key={i} className="grid gap-2 sm:grid-cols-[1fr_12rem_1fr_auto]">
          <Input aria-label={l["editor.path"]} placeholder="data.kind" value={r.path} disabled={disabled} onChange={(e) => update(rows.map((x, j) => (j === i ? { ...x, path: e.target.value } : x)))} />
          <select aria-label={l["editor.operator"]} title={l[`editor.op_help.${r.op}`]} className={selectClass} value={r.op} disabled={disabled} onChange={(e) => update(rows.map((x, j) => (j === i ? { ...x, op: e.target.value as Row["op"] } : x)))}>
            {OPERATORS.map((op) => (
              <option key={op} value={op}>
                {l[`editor.op.${op}`] ?? op}
              </option>
            ))}
          </select>
          <Input aria-label={l["editor.value"]} title={l["editor.value_hint"]} value={r.value} disabled={disabled} onChange={(e) => update(rows.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} />
          <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={() => update(rows.filter((_, j) => j !== i))}>
            {l["common.remove"]}
          </Button>
        </div>
      ))}
      <Button type="button" variant="outline" size="sm" className="w-fit" disabled={disabled} onClick={() => update([...rows, { path: "", op: "eq", value: "" }])}>
        {l["editor.add_where"]}
      </Button>
    </div>
  );
}

export type CardProps = { def: Obj; set: (patch: Obj, drop?: string[]) => void; l: Labels; options: EditorOptions; issues: IssueView[]; disabled: boolean };

const issuesAt = (issues: IssueView[], prefix: string) => issues.filter((i) => i.path === prefix || i.path.startsWith(`${prefix}.`));

export function TriggerCard({ def, set, l, options, issues, disabled }: CardProps) {
  const id = useId();
  const trigger = asObj(def.trigger);
  const mode = "segment_enter" in trigger ? "segment" : "manual" in trigger ? "manual" : "event";
  const kinds = mode === "event" ? (Array.isArray(trigger.event) ? trigger.event.map(String) : trigger.event ? [String(trigger.event)] : []) : [];
  const setKinds = (next: string[]) => set({ trigger: { ...trigger, event: next.length === 1 ? next[0]! : next } });
  return (
    <Card data-testid="trigger-card">
      <CardHeader>
        <CardTitle>{l["editor.trigger"]}</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        <fieldset className="grid gap-2" disabled={disabled}>
          <legend className="text-sm font-medium">{l["editor.trigger_type"]}</legend>
          {(["event", "segment", "manual"] as const).map((m) => (
            <label key={m} className="flex items-start gap-2 text-sm">
              <input
                type="radio"
                name={`${id}-trigger`}
                checked={mode === m}
                onChange={() => set({ trigger: m === "event" ? { event: options.eventKinds[0] ?? "" } : m === "segment" ? { segment_enter: options.segments[0]?.id ?? "" } : { manual: true } })}
              />
              <span>
                <span className="font-medium">{l[`editor.trigger_${m}`]}</span>
                <span className="block text-xs text-muted-foreground">{l[`editor.trigger_${m}_help`]}</span>
              </span>
            </label>
          ))}
        </fieldset>
        {mode === "event" ? (
          <div className="grid gap-2">
            <span className="text-sm font-medium">{l["editor.event_kinds"]}</span>
            <p className="text-xs text-muted-foreground">{l["editor.event_kinds_hint"]}</p>
            {kinds.map((k, i) => (
              <div key={i} className="flex gap-2">
                <select aria-label={l["editor.event_kind"]} className={selectClass} value={k} disabled={disabled} onChange={(e) => setKinds(kinds.map((x, j) => (j === i ? e.target.value : x)))}>
                  {options.eventKinds.includes(k) ? null : <option value={k}>{k}</option>}
                  {options.eventKinds.map((ek) => (
                    <option key={ek} value={ek}>
                      {ek}
                    </option>
                  ))}
                </select>
                {kinds.length > 1 ? (
                  <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={() => setKinds(kinds.filter((_, j) => j !== i))}>
                    {l["common.remove"]}
                  </Button>
                ) : null}
              </div>
            ))}
            <Button type="button" variant="outline" size="sm" className="w-fit" disabled={disabled} onClick={() => setKinds([...kinds, options.eventKinds[0] ?? ""])}>
              {l["editor.add_kind"]}
            </Button>
            <span className="text-sm font-medium">{l["editor.where"]}</span>
            <WhereRows
              value={trigger.where === undefined ? undefined : asObj(trigger.where)}
              disabled={disabled}
              l={l}
              onChange={(f) => {
                const next: Obj = { ...trigger };
                if (f) next.where = f;
                else delete next.where;
                set({ trigger: next });
              }}
            />
          </div>
        ) : null}
        {mode === "segment" ? (
          <Field label={l["editor.segment"] ?? ""} issues={issuesAt(issues, "trigger")}>
            {(fid, d) => (
              <select id={fid} aria-describedby={d} className={selectClass} disabled={disabled} value={String(trigger.segment_enter ?? "")} onChange={(e) => set({ trigger: { segment_enter: e.target.value } })}>
                <option value="">{l["editor.segment_none"]}</option>
                {options.segments.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
        ) : null}
        {mode !== "segment" ? <IssueList issues={issuesAt(issues, "trigger")} /> : null}
      </CardContent>
    </Card>
  );
}

export function IssueList({ issues }: { issues: IssueView[] }) {
  if (!issues.length) return null;
  return (
    <ul className="grid gap-1 text-xs">
      {issues.map((i, n) => (
        <li key={n} className={i.severity === "error" ? "text-destructive" : "text-amber-700 dark:text-amber-400"} data-issue={i.code}>
          {i.text}
        </li>
      ))}
    </ul>
  );
}

/** Anchor (enrolment or a trigger date path) and subject (per person or per trigger ref). */
export function TimingCard({ def, set, l, issues, disabled }: CardProps) {
  const anchor = String(def.anchor ?? "enrolment");
  const isData = anchor !== "enrolment";
  return (
    <Card>
      <CardHeader>
        <CardTitle>{l["editor.timing"]}</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3 sm:grid-cols-2">
        <Field label={l["editor.anchor"] ?? ""} issues={issuesAt(issues, "anchor")}>
          {(id, d) => (
            <select id={id} aria-describedby={d} className={selectClass} disabled={disabled} value={isData ? "data" : "enrolment"} onChange={(e) => set({ anchor: e.target.value === "data" ? "data.starts_at" : "enrolment" })}>
              <option value="enrolment">{l["editor.anchor_enrolment"]}</option>
              <option value="data">{l["editor.anchor_data"]}</option>
            </select>
          )}
        </Field>
        {isData ? (
          <Field label={l["editor.anchor_path"] ?? ""} hint={l["editor.anchor_path_hint"]}>
            {(id, d) => <Input id={id} aria-describedby={d} disabled={disabled} value={anchor} onChange={(e) => set({ anchor: e.target.value })} />}
          </Field>
        ) : null}
        <Field label={l["editor.subject"] ?? ""} issues={issuesAt(issues, "subject")}>
          {(id, d) => (
            <select id={id} aria-describedby={d} className={selectClass} disabled={disabled} value={def.subject === "ref" ? "ref" : ""} onChange={(e) => (e.target.value ? set({ subject: "ref" }) : set({}, ["subject"]))}>
              <option value="">{l["editor.subject_none"]}</option>
              <option value="ref">{l["editor.subject_ref"]}</option>
            </select>
          )}
        </Field>
      </CardContent>
    </Card>
  );
}

/** Status, segment, exclusions, languages and the marketing-consent entry check. */
export function AudienceCard({ def, set, l, options, issues, disabled }: CardProps) {
  const a = asObj(def.audience);
  const setA = (patch: Obj, drop: string[] = []) => {
    const next: Obj = { ...a, ...patch };
    for (const k of drop) delete next[k];
    if (Object.keys(next).length) set({ audience: next });
    else set({}, ["audience"]);
  };
  const list = (k: string) => (Array.isArray(a[k]) ? (a[k] as Json[]).map(String) : []);
  const toggle = (k: string, v: string, on: boolean) => {
    const next = on ? [...list(k), v] : list(k).filter((x) => x !== v);
    if (next.length) setA({ [k]: next });
    else setA({}, [k]);
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>{l["editor.audience"]}</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        <fieldset className="grid gap-1" disabled={disabled}>
          <legend className="text-sm font-medium">{l["editor.audience_status"]}</legend>
          <div className="flex flex-wrap gap-3">
            {STATUSES.map((s) => (
              <label key={s} className="flex items-center gap-1 text-sm">
                <input type="checkbox" checked={list("status").includes(s)} onChange={(e) => toggle("status", s, e.target.checked)} />
                {l[`editor.person_status.${s}`]}
              </label>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">{l["editor.audience_status_hint"]}</p>
        </fieldset>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={l["editor.audience_segment"] ?? ""}>
            {(id) => (
              <select id={id} className={selectClass} disabled={disabled} value={String(a.segment_id ?? "")} onChange={(e) => (e.target.value ? setA({ segment_id: e.target.value }) : setA({}, ["segment_id"]))}>
                <option value="">{l["common.none"]}</option>
                {options.segments.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <fieldset className="grid gap-1" disabled={disabled}>
            <legend className="text-sm font-medium">{l["editor.audience_exclude"]}</legend>
            <div className="flex max-h-32 flex-col gap-1 overflow-auto">
              {options.segments.map((s) => (
                <label key={s.id} className="flex items-center gap-1 text-sm">
                  <input type="checkbox" checked={list("exclude_segment_ids").includes(s.id)} onChange={(e) => toggle("exclude_segment_ids", s.id, e.target.checked)} />
                  {s.name}
                </label>
              ))}
            </div>
          </fieldset>
        </div>
        <fieldset className="grid gap-1" disabled={disabled}>
          <legend className="text-sm font-medium">{l["editor.audience_locales"]}</legend>
          <div className="flex flex-wrap gap-3">
            {LOCALES.map((loc) => (
              <label key={loc} className="flex items-center gap-1 text-sm">
                <input type="checkbox" checked={list("locales").includes(loc)} onChange={(e) => toggle("locales", loc, e.target.checked)} />
                {l[`editor.locale.${loc}`]}
              </label>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">{l["editor.audience_locales_hint"]}</p>
        </fieldset>
        <Field label={l["editor.require_reachable"] ?? ""}>
          {(id) => (
            <select
              id={id}
              className={selectClass}
              disabled={disabled}
              value={a.require_reachable === undefined ? "" : a.require_reachable ? "yes" : "no"}
              onChange={(e) => (e.target.value ? setA({ require_reachable: e.target.value === "yes" }) : setA({}, ["require_reachable"]))}
            >
              <option value="">{l["editor.require_reachable_default"]}</option>
              <option value="yes">{l["editor.require_reachable_yes"]}</option>
              <option value="no">{l["editor.require_reachable_no"]}</option>
            </select>
          )}
        </Field>
        <IssueList issues={issuesAt(issues, "audience")} />
      </CardContent>
    </Card>
  );
}

/** Re-entry policy and the exit-on list (`kind`, `kind:qualifier` or `{ event, same_subject }`). */
export function ReEntryExitCard({ def, set, l, options, issues, disabled }: CardProps) {
  const re = String(def.re_entry ?? "never");
  const days = re.startsWith("after_days:") ? re.slice(11) : "";
  const exits = Array.isArray(def.exit_on) ? def.exit_on : [];
  const parts = (e: Json) => {
    if (typeof e === "string") {
      const [kind, q] = e.split(":");
      return { kind: kind ?? "", qualifier: q ?? "", sameSubject: false };
    }
    const o = asObj(e);
    return { kind: String(o.event ?? ""), qualifier: "", sameSubject: o.same_subject === true, where: o.where };
  };
  const build = (p: ReturnType<typeof parts>): Json => {
    if (p.sameSubject || p.where) return { event: p.kind, ...(p.where ? { where: p.where } : {}), ...(p.sameSubject ? { same_subject: true } : {}) };
    return p.qualifier ? `${p.kind}:${p.qualifier}` : p.kind;
  };
  const setExits = (next: Json[]) => set({ exit_on: next });
  return (
    <Card>
      <CardHeader>
        <CardTitle>{l["editor.re_entry"]}</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={l["editor.re_entry"] ?? ""} issues={issuesAt(issues, "re_entry")}>
            {(id, d) => (
              <select id={id} aria-describedby={d} className={selectClass} disabled={disabled} value={days ? "after" : re} onChange={(e) => set({ re_entry: e.target.value === "after" ? "after_days:30" : e.target.value })}>
                <option value="never">{l["editor.re_entry_never"]}</option>
                <option value="always">{l["editor.re_entry_always"]}</option>
                <option value="after">{l["editor.re_entry_after"]}</option>
              </select>
            )}
          </Field>
          {days ? (
            <Field label={l["editor.re_entry_days"] ?? ""}>
              {(id) => <Input id={id} type="number" min={0} disabled={disabled} value={days} onChange={(e) => set({ re_entry: `after_days:${Math.max(0, Math.trunc(Number(e.target.value) || 0))}` })} />}
            </Field>
          ) : null}
        </div>
        <div className="grid gap-2">
          <span className="text-sm font-medium">{l["editor.exit_on"]}</span>
          <p className="text-xs text-muted-foreground">{l["editor.exit_on_hint"]}</p>
          {exits.map((e, i) => {
            const p = parts(e);
            const upd = (patch: Partial<ReturnType<typeof parts>>) => setExits(exits.map((x, j) => (j === i ? build({ ...p, ...patch }) : x)));
            return (
              <div key={i} className="grid gap-2 sm:grid-cols-[1fr_10rem_auto_auto]">
                <select aria-label={l["editor.exit_kind"]} className={selectClass} disabled={disabled} value={p.kind} onChange={(ev) => upd({ kind: ev.target.value })}>
                  {options.eventKinds.includes(p.kind) ? null : <option value={p.kind}>{p.kind}</option>}
                  {options.eventKinds.map((k) => (
                    <option key={k} value={k}>
                      {k}
                    </option>
                  ))}
                </select>
                <Input aria-label={l["editor.exit_qualifier"]} title={l["editor.exit_qualifier_hint"]} disabled={disabled || p.sameSubject} value={p.qualifier} onChange={(ev) => upd({ qualifier: ev.target.value })} />
                <label className="flex items-center gap-1 text-sm">
                  <input type="checkbox" disabled={disabled} checked={p.sameSubject} onChange={(ev) => upd({ sameSubject: ev.target.checked, qualifier: "" })} />
                  {l["editor.exit_same_subject"]}
                </label>
                <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={() => setExits(exits.filter((_, j) => j !== i))}>
                  {l["common.remove"]}
                </Button>
              </div>
            );
          })}
          <Button type="button" variant="outline" size="sm" className="w-fit" disabled={disabled} onClick={() => setExits([...exits, options.eventKinds[0] ?? ""])}>
            {l["editor.add_exit"]}
          </Button>
          <IssueList issues={issuesAt(issues, "exit_on")} />
        </div>
      </CardContent>
    </Card>
  );
}
