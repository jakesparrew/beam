"use client";
/**
 * The steps list of the form editor (automation spec 5): one form per step type (template picker
 * with locales and purpose, wait, branch with the condition builder, task fields, tag picker,
 * preferred channel, status override, enrol and exit targets, Slack text, webhook URL), the
 * shared timing fields (`at`, `snap_to`, `late_entry`) and an optional "skip when" condition.
 * Steps move with "Move up" / "Move down" buttons. Validation issues show beside their step.
 */
import { useId, useState } from "react";
import { Button, Input, Textarea } from "@beam/ui";
import { STEP_TYPES, type StepType } from "@beam/core/automation";
import { ConditionBuilder, selectClass, type EditorOptions, type Json } from "./condition-builder";
import { fill, type Labels, str } from "./outcome-badge";

export type StepJson = { [k: string]: Json };
export type IssueView = { path: string; code: string; severity: "error" | "warning"; text: string };

const TASK_KINDS = ["call", "follow_up", "payment", "proposal", "review", "other"] as const;
const TASK_PRIORITIES = ["low", "normal", "high"] as const;
const CHANNELS = ["email", "phone", "whatsapp"] as const;
const STATUSES = ["lead", "customer", "member"] as const;

const asObj = (v: Json | undefined): { [k: string]: Json } => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
const num = (raw: string, fallback = 0) => (raw.trim() === "" || Number.isNaN(Number(raw)) ? fallback : Math.trunc(Number(raw)));

/** A fresh step of a type with a key unique among `keys`. */
export function newStep(type: StepType, keys: string[], o: EditorOptions): StepJson {
  let n = 1;
  while (keys.includes(`${type}_${n}`)) n++;
  const key = `${type}_${n}`;
  const base: StepJson = { key, type, at: { from: "previous", minutes: 0 } };
  switch (type) {
    case "email":
      return { ...base, template: o.templates[0]?.slug ?? "" };
    case "wait":
      return { key, type, minutes: 1440 };
    case "condition":
      return { ...base, if: { has_active_membership: true }, then: "end", else: "end" };
    case "task":
      return { ...base, title: "", kind: "follow_up", owner_role: o.roles.includes("customer_service") ? "customer_service" : (o.roles[0] ?? ""), due_in_minutes: 1440, priority: "normal" };
    case "tag":
    case "untag":
      return { ...base, tag: o.tags[0] ?? "" };
    case "set_field":
      return { ...base, field: "preferred_channel", value: "email" };
    case "status_override":
      return { ...base, value: "customer", reason: "" };
    case "enrol":
      return { ...base, automation: o.automations[0]?.slug ?? "" };
    case "exit":
      return { ...base };
    case "notify_slack":
      return { ...base, text: "" };
    case "webhook":
      return { ...base, url: "https://" };
  }
}

function Field({ label, hint, children, issues }: { label: string; hint?: React.ReactNode; children: (id: string, describedBy: string | undefined) => React.ReactNode; issues?: IssueView[] }) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errId = issues?.length ? `${id}-issues` : undefined;
  const describedBy = [hintId, errId].filter(Boolean).join(" ") || undefined;
  return (
    <div className="grid gap-1">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      {children(id, describedBy)}
      {hint ? (
        <p id={hintId} className="text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
      {issues?.length ? (
        <ul id={errId} className="text-xs">
          {issues.map((i, n) => (
            <li key={n} className={i.severity === "error" ? "text-destructive" : "text-amber-700 dark:text-amber-400"} data-issue={i.code}>
              {i.text}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export { Field };

/**
 * The form of one step (no move, remove or add controls). `steps` is the whole flow: its keys
 * feed the condition builders and the goto targets after `index`; issue paths are
 * `steps.<index>.<field>`. The builder's side panel renders it for the selected block.
 */
export function StepForm({
  step,
  index,
  steps,
  onChange,
  l,
  options,
  issues,
  disabled,
}: {
  step: StepJson;
  index: number;
  steps: StepJson[];
  onChange: (s: StepJson) => void;
  l: Labels;
  options: EditorOptions;
  issues: IssueView[];
  disabled: boolean;
}) {
  const type = str(step.type) as StepType;
  const at = step.at === undefined ? null : asObj(step.at);
  const set = (patch: StepJson) => onChange({ ...step, ...patch });
  const on = (field: string) => issues.filter((i) => i.path === `steps.${index}.${field}` || i.path.startsWith(`steps.${index}.${field}.`));
  const later = steps.slice(index + 1).map((s) => str(s.key));
  const stepKeys = steps.map((s) => str(s.key));
  const tpl = options.templates.find((t) => t.slug === step.template);

  return (
    <fieldset disabled={disabled} className="grid gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={l["editor.step_key"] ?? ""} hint={l["editor.step_key_hint"]} issues={on("key")}>
          {(id, d) => <Input id={id} aria-describedby={d} name={`steps.${index}.key`} value={str(step.key, "")} onChange={(e) => set({ key: e.target.value })} />}
        </Field>
        {type !== "wait" ? (
          <Field label={l["editor.at"] ?? ""} issues={on("at")}>
            {(id, d) => (
              <select
                id={id}
                aria-describedby={d}
                className={selectClass}
                value={at ? str(at.from) : ""}
                onChange={(e) => {
                  if (!e.target.value) {
                    const { at: _drop, ...rest } = step;
                    onChange(rest);
                  } else set({ at: { ...(at ?? { minutes: 0 }), from: e.target.value } });
                }}
              >
                <option value="">{l["editor.at_none"]}</option>
                <option value="enrolment">{l["editor.at_enrolment"]}</option>
                <option value="anchor">{l["editor.at_anchor"]}</option>
                <option value="previous">{l["editor.at_previous"]}</option>
              </select>
            )}
          </Field>
        ) : null}
      </div>
      {at ? (
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label={l["editor.at_minutes"] ?? ""} hint={l["editor.at_minutes_hint"]}>
            {(id, d) => <Input id={id} aria-describedby={d} type="number" name={`steps.${index}.at.minutes`} data-testid={`step-${index}-minutes`} value={str(at.minutes, 0)} onChange={(e) => set({ at: { ...at, minutes: num(e.target.value) } })} />}
          </Field>
          <Field label={l["editor.snap_to"] ?? ""} hint={l["editor.snap_to_hint"]}>
            {(id, d) => (
              <Input
                id={id}
                aria-describedby={d}
                placeholder="10:00"
                value={str(at.snap_to, "")}
                onChange={(e) => {
                  const next: { [k: string]: Json } = { ...at, snap_to: e.target.value };
                  if (!e.target.value) delete next.snap_to;
                  set({ at: next });
                }}
              />
            )}
          </Field>
          <Field label={l["editor.late_entry"] ?? ""}>
            {(id) => (
              <select
                id={id}
                className={selectClass}
                value={str(step.late_entry, "skip")}
                onChange={(e) => {
                  if (e.target.value === "skip") {
                    const { late_entry: _drop, ...rest } = step;
                    onChange(rest);
                  } else set({ late_entry: e.target.value });
                }}
              >
                <option value="skip">{l["editor.late_entry_skip"]}</option>
                <option value="send_now">{l["editor.late_entry_send_now"]}</option>
              </select>
            )}
          </Field>
        </div>
      ) : null}

      {type === "email" ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={l["editor.template"] ?? ""} issues={on("template")} hint={tpl ? `${tpl.kind}${tpl.purpose ? ` · ${tpl.purpose}` : ""} · ${tpl.locales.join(", ")}` : undefined}>
            {(id, d) => (
              <select id={id} aria-describedby={d} className={selectClass} value={str(step.template, "")} onChange={(e) => set({ template: e.target.value })}>
                <option value="">{l["editor.template_none"]}</option>
                {step.template && !tpl ? <option value={str(step.template)}>{fill(l["editor.template_unlisted"], { slug: str(step.template) })}</option> : null}
                {options.templates.map((t) => (
                  <option key={t.slug} value={t.slug}>
                    {fill(l["editor.template_option"], { slug: t.slug, kind: t.kind, locales: t.locales.join(", ") })}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label={l["editor.send_as"] ?? ""} hint={l["editor.send_as_hint"]} issues={on("send_as")}>
            {(id, d) => (
              <input
                id={id}
                aria-describedby={d}
                type="checkbox"
                className="size-4"
                checked={step.send_as === "marketing"}
                onChange={(e) => {
                  if (e.target.checked) set({ send_as: "marketing" });
                  else {
                    const { send_as: _drop, ...rest } = step;
                    onChange(rest);
                  }
                }}
              />
            )}
          </Field>
        </div>
      ) : null}
      {type === "wait" ? (
        <Field label={l["editor.wait_minutes"] ?? ""} issues={on("minutes")}>
          {(id, d) => <Input id={id} aria-describedby={d} type="number" min={0} value={str(step.minutes, 0)} onChange={(e) => set({ minutes: num(e.target.value) })} />}
        </Field>
      ) : null}
      {type === "condition" ? (
        <div className="grid gap-3">
          <div className="grid gap-1">
            <span className="text-sm font-medium">{l["editor.if"]}</span>
            <ConditionBuilder value={asObj(step.if)} onChange={(c) => set({ if: c })} l={l} options={options} stepKeys={stepKeys} />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {(["then", "else"] as const).map((branch) => (
              <Field key={branch} label={l[`editor.${branch}`] ?? ""} issues={on(branch)}>
                {(id, d) => (
                  <select id={id} aria-describedby={d} className={selectClass} value={str(step[branch], "end")} onChange={(e) => set({ [branch]: e.target.value })}>
                    <option value="end">{l["editor.branch_end"]}</option>
                    {later.map((k) => (
                      <option key={k} value={k}>
                        {k}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
            ))}
          </div>
        </div>
      ) : null}
      {type === "task" ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={l["editor.task_title"] ?? ""} hint={<>{l["editor.task_title_hint"]} <code>{"{{trigger.data.field_name}}"}</code></>} issues={on("title")}>
            {(id, d) => <Input id={id} aria-describedby={d} value={str(step.title, "")} onChange={(e) => set({ title: e.target.value })} />}
          </Field>
          <Field label={l["editor.task_kind"] ?? ""}>
            {(id) => (
              <select id={id} className={selectClass} value={str(step.kind, "follow_up")} onChange={(e) => set({ kind: e.target.value })}>
                {TASK_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {l[`editor.task_kind.${k}`]}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label={l["editor.task_owner"] ?? ""}>
            {(id) => (
              <select
                id={id}
                className={selectClass}
                value={str(step.owner, "role")}
                onChange={(e) => {
                  if (e.target.value === "role") {
                    const { owner: _drop, ...rest } = step;
                    onChange(rest);
                  } else set({ owner: e.target.value });
                }}
              >
                <option value="role">{l["editor.task_owner_role_opt"]}</option>
                <option value="trigger_owner">{l["editor.task_owner_trigger"]}</option>
              </select>
            )}
          </Field>
          <Field label={l["editor.task_owner_role"] ?? ""} issues={on("owner_role")}>
            {(id, d) => (
              <select id={id} aria-describedby={d} className={selectClass} value={str(step.owner_role, "")} onChange={(e) => set({ owner_role: e.target.value })}>
                {options.roles.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label={l["editor.task_due"] ?? ""}>
            {(id) => <Input id={id} type="number" min={0} value={str(step.due_in_minutes, 0)} onChange={(e) => set({ due_in_minutes: num(e.target.value) })} />}
          </Field>
          <Field label={l["editor.task_priority"] ?? ""}>
            {(id) => (
              <select id={id} className={selectClass} value={str(step.priority, "normal")} onChange={(e) => set({ priority: e.target.value })}>
                {TASK_PRIORITIES.map((k) => (
                  <option key={k} value={k}>
                    {l[`editor.task_priority.${k}`]}
                  </option>
                ))}
              </select>
            )}
          </Field>
        </div>
      ) : null}
      {type === "tag" || type === "untag" ? (
        <Field label={l["editor.tag"] ?? ""} issues={on("tag")}>
          {(id, d) => (
            <select id={id} aria-describedby={d} className={selectClass} value={str(step.tag, "")} onChange={(e) => set({ tag: e.target.value })}>
              <option value="">{l["editor.tag_none"]}</option>
              {options.tags.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          )}
        </Field>
      ) : null}
      {type === "set_field" ? (
        <Field label={l["editor.set_field_value"] ?? ""}>
          {(id) => (
            <select id={id} className={selectClass} value={str(step.value, "email")} onChange={(e) => set({ field: "preferred_channel", value: e.target.value })}>
              {CHANNELS.map((c) => (
                <option key={c} value={c}>
                  {l[`editor.channel.${c}`]}
                </option>
              ))}
            </select>
          )}
        </Field>
      ) : null}
      {type === "status_override" ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={l["editor.status_value"] ?? ""}>
            {(id) => (
              <select id={id} className={selectClass} value={step.value === null ? "" : str(step.value, "")} onChange={(e) => set({ value: e.target.value || null })}>
                <option value="">{l["editor.status_value_none"]}</option>
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {l[`editor.person_status.${s}`]}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label={l["editor.status_reason"] ?? ""} issues={on("reason")}>
            {(id, d) => <Input id={id} aria-describedby={d} value={str(step.reason, "")} onChange={(e) => set({ reason: e.target.value })} />}
          </Field>
        </div>
      ) : null}
      {type === "enrol" || type === "exit" ? (
        <Field label={l[type === "enrol" ? "editor.enrol_target" : "editor.exit_target"] ?? ""} issues={on("automation")}>
          {(id, d) => (
            <select
              id={id}
              aria-describedby={d}
              className={selectClass}
              value={str(step.automation, "")}
              onChange={(e) => {
                if (!e.target.value && type === "exit") {
                  const { automation: _drop, ...rest } = step;
                  onChange(rest);
                } else set({ automation: e.target.value });
              }}
            >
              <option value="">{type === "exit" ? l["editor.exit_target_self"] : l["editor.automation_none"]}</option>
              {options.automations.map((a) => (
                <option key={a.slug} value={a.slug}>
                  {`${a.name} (${a.slug})`}
                </option>
              ))}
            </select>
          )}
        </Field>
      ) : null}
      {type === "notify_slack" ? (
        <Field label={l["editor.slack_text"] ?? ""} hint={<>{l["editor.slack_text_hint"]} <code>{"{{first_name}} {{person_url}} {{automation}}"}</code></>} issues={on("text")}>
          {(id, d) => <Textarea id={id} aria-describedby={d} rows={3} value={str(step.text, "")} onChange={(e) => set({ text: e.target.value })} />}
        </Field>
      ) : null}
      {type === "webhook" ? (
        <Field label={l["editor.webhook_url"] ?? ""} hint={l["editor.webhook_url_hint"]} issues={on("url")}>
          {(id, d) => <Input id={id} aria-describedby={d} type="url" value={str(step.url, "")} onChange={(e) => set({ url: e.target.value })} />}
        </Field>
      ) : null}

      <div className="grid gap-2">
        {step.unless !== undefined ? (
          <div className="grid gap-1">
            <span className="text-sm font-medium">{l["editor.unless"]}</span>
            <ConditionBuilder
              value={asObj(step.unless)}
              onChange={(c) => set({ unless: c })}
              onRemove={() => {
                const { unless: _drop, ...rest } = step;
                onChange(rest);
              }}
              l={l}
              options={options}
              stepKeys={stepKeys}
            />
          </div>
        ) : (
          <Button type="button" variant="ghost" size="sm" className="w-fit" onClick={() => set({ unless: { has_future_booking: true } })}>
            {l["editor.unless_add"]}
          </Button>
        )}
      </div>
    </fieldset>
  );
}

/** Every step with its form, move and remove buttons, and an "Add step" picker. */
export function StepForms({
  steps,
  onChange,
  l,
  options,
  issues,
  disabled,
}: {
  steps: StepJson[];
  onChange: (steps: StepJson[]) => void;
  l: Labels;
  options: EditorOptions;
  issues: IssueView[];
  disabled: boolean;
}) {
  const addId = useId();
  const [addType, setAddType] = useState<StepType>("email");
  const keys = steps.map((s) => str(s.key));
  const move = (i: number, by: -1 | 1) => {
    const next = [...steps];
    const [s] = next.splice(i, 1);
    next.splice(i + by, 0, s!);
    onChange(next);
  };
  return (
    <div className="grid gap-4" data-testid="step-forms">
      <ol className="grid gap-4">
        {steps.map((step, i) => {
          const type = str(step.type) as StepType;
          const stepIssues = issues.filter((x) => x.path === `steps.${i}` || x.path.startsWith(`steps.${i}.`));
          return (
            <li key={i} className="grid gap-3 rounded-lg border p-4" data-step-key={str(step.key)} data-testid={`step-${i}`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="font-semibold">{fill(l["editor.step_n"], { n: i + 1, type: l[`editor.step_type.${type}`] ?? type })}</h3>
                <div className="flex gap-1">
                  <Button type="button" variant="ghost" size="sm" disabled={disabled || i === 0} onClick={() => move(i, -1)} aria-label={`${l["common.move_up"]} ${str(step.key)}`}>
                    {l["common.move_up"]}
                  </Button>
                  <Button type="button" variant="ghost" size="sm" disabled={disabled || i === steps.length - 1} onClick={() => move(i, 1)} aria-label={`${l["common.move_down"]} ${str(step.key)}`}>
                    {l["common.move_down"]}
                  </Button>
                  <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={() => onChange(steps.filter((_, j) => j !== i))} aria-label={`${l["common.remove"]} ${str(step.key)}`}>
                    {l["common.remove"]}
                  </Button>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">{l[`editor.step_help.${type}`]}</p>
              {stepIssues.filter((x) => x.path === `steps.${i}`).map((x, n) => (
                <p key={n} className="text-xs text-destructive" data-issue={x.code}>
                  {x.text}
                </p>
              ))}
              <StepForm step={step} index={i} steps={steps} onChange={(s) => onChange(steps.map((x, j) => (j === i ? s : x)))} l={l} options={options} issues={stepIssues} disabled={disabled} />
            </li>
          );
        })}
      </ol>
      {!disabled ? (
        <div className="flex flex-wrap items-end gap-2">
          <div className="grid gap-1">
            <label htmlFor={addId} className="text-sm font-medium">
              {l["editor.step_kind"]}
            </label>
            <select id={addId} className={selectClass} value={addType} onChange={(e) => setAddType(e.target.value as StepType)} data-testid="add-step-type">
              {STEP_TYPES.map((t) => (
                <option key={t} value={t}>
                  {l[`editor.step_type.${t}`] ?? t}
                </option>
              ))}
            </select>
          </div>
          <Button type="button" variant="outline" onClick={() => onChange([...steps, newStep(addType, keys, options)])}>
            {l["editor.add_step"]}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
