"use client";
/**
 * The V1 form-based editor over `automations.draft_definition` (automation spec 5): settings,
 * trigger, timing, audience, re-entry and exits, the steps with one form per type, and a "JSON"
 * tab with the same draft as text. Save draft posts `saveDraft` (saved even with issues; the
 * returned issues show beside their fields), Validate parses the draft in the browser with the
 * same Zod schema, Publish opens the publish dialog. Also the new-automation form
 * (`/admin/automations/new`). Every string arrives as a prop.
 *
 * "Open the visual builder" links to `/admin/automations/[id]/builder` (R4, automation-P10), the
 * same draft as a flow of blocks; unsaved form changes stay here until saved.
 *
 * Purpose `b2b` (R3, automation-P9): B2B journeys create tasks and Slack messages only, because
 * automated B2B outbound email is "Later" (spec 1, decision 35). Both forms say so when `b2b` is
 * chosen, and the editor warns while the draft still has email steps.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, type FormEvent } from "react";
import { Alert, AlertDescription, Button, Card, CardContent, CardHeader, CardTitle, FormField, Input, Tabs, TabsContent, TabsList, TabsTrigger, Textarea } from "@beam/ui";
import { AUTOMATION_PURPOSES, parseDefinition, type AutomationPurpose, type DefinitionIssue } from "@beam/core/automation";
import { createAutomation, saveDraft } from "../actions";
import { selectClass, type EditorOptions, type Json } from "./condition-builder";
import { errorText, issueText, type IssueLike, type Labels, formStr } from "./outcome-badge";
import { PublishDialog } from "./publish-dialog";
import { Field, StepForms, type IssueView, type StepJson } from "./step-forms";
import { AudienceCard, IssueList, ReEntryExitCard, TimingCard, TriggerCard } from "./trigger-card";

type Obj = { [k: string]: Json };
const PURPOSES = AUTOMATION_PURPOSES;

export type EditorAutomation = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  groupKey: string;
  priority: number;
  isMarketing: boolean;
  purpose: AutomationPurpose | null;
};

const toViews = (issues: readonly IssueLike[], l: Labels): IssueView[] => issues.map((i) => ({ path: i.path, code: i.code, severity: i.severity, text: issueText(i, l) }));
const isFormShaped = (d: unknown): d is Obj => !!d && typeof d === "object" && !Array.isArray(d) && Array.isArray((d as Obj).steps);

/** The keys of the draft's `email` steps (a B2B journey must have none, decision 35). */
export function emailStepKeys(def: unknown): string[] {
  const steps = isFormShaped(def) ? (def.steps as Json[]) : [];
  return steps.flatMap((st) => (st && typeof st === "object" && !Array.isArray(st) && st.type === "email" ? [typeof st.key === "string" ? st.key : ""] : []));
}

export function DefinitionEditor({
  automation,
  draft,
  issues: savedIssues,
  options,
  groups,
  migratableCount,
  canEdit,
  canPublish,
  labels: l,
}: {
  automation: EditorAutomation;
  draft: unknown;
  issues: DefinitionIssue[];
  options: EditorOptions;
  groups: { key: string; name: string }[];
  migratableCount: number;
  canEdit: boolean;
  canPublish: boolean;
  labels: Labels;
}) {
  const router = useRouter();
  const [def, setDef] = useState<Obj>(() => (isFormShaped(draft) ? draft : ((draft ?? {}) as Obj)));
  const [settings, setSettings] = useState(automation);
  const [tab, setTab] = useState<string>(isFormShaped(draft) ? "form" : "json");
  const [json, setJson] = useState(() => JSON.stringify(draft ?? {}, null, 2));
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [issues, setIssues] = useState<IssueLike[]>(savedIssues);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const views = useMemo(() => toViews(issues, l), [issues, l]);
  const disabled = !canEdit;

  const set = (patch: Obj, drop: string[] = []) => {
    setDef((d) => {
      const next: Obj = { ...d, ...patch };
      for (const k of drop) delete next[k];
      return next;
    });
    setDirty(true);
    setMessage(null);
  };
  const setSetting = (patch: Partial<EditorAutomation>) => {
    setSettings((s) => ({ ...s, ...patch }));
    setDirty(true);
  };

  async function save() {
    setBusy(true);
    setMessage(null);
    try {
      const r = await saveDraft({
        automationId: automation.id,
        definition: def,
        name: settings.name,
        description: settings.description,
        groupKey: settings.groupKey,
        priority: settings.priority,
        isMarketing: settings.isMarketing,
        purpose: settings.purpose,
      });
      if (r.ok) {
        setIssues(r.data.issues);
        setDirty(false);
        setMessage({ kind: "ok", text: l["editor.saved"] ?? "" });
        router.refresh();
      } else setMessage({ kind: "error", text: errorText(r.error, l) });
    } catch {
      setMessage({ kind: "error", text: l["errors.generic"] ?? "" });
    } finally {
      setBusy(false);
    }
  }

  function validate() {
    const parsed = parseDefinition(def);
    setIssues(parsed.ok ? (dirty ? [] : savedIssues) : parsed.issues);
    setMessage(null);
  }

  function applyJson() {
    try {
      const value = JSON.parse(json) as Json;
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
      setDef(value);
      setDirty(true);
      setJsonError(null);
      const parsed = parseDefinition(value);
      setIssues(parsed.ok ? [] : parsed.issues);
    } catch {
      setJsonError(l["errors.json_invalid"] ?? "");
    }
  }

  const steps = Array.isArray(def.steps) ? (def.steps as StepJson[]) : [];
  const cardProps = { def, set, l, options, issues: views, disabled };
  const errorsCount = issues.filter((i) => i.severity === "error").length;
  const b2bEmailSteps = settings.purpose === "b2b" ? emailStepKeys(def) : [];

  return (
    <div className="grid gap-6" data-testid="definition-editor">
      {disabled ? <p className="text-sm text-muted-foreground">{l["editor.readonly"]}</p> : null}
      <div className="flex flex-wrap items-center gap-2">
        {canEdit ? (
          <Button onClick={() => void save()} disabled={busy} data-testid="editor-save">
            {busy ? l["common.saving"] : l["editor.save"]}
          </Button>
        ) : null}
        <Button variant="outline" onClick={validate} data-testid="editor-validate">
          {l["editor.validate"]}
        </Button>
        {canPublish ? <PublishDialog automationId={automation.id} migratableCount={migratableCount} issues={savedIssues} dirty={dirty} labels={l} /> : null}
        {isFormShaped(def) ? (
          <Button asChild variant="outline">
            <Link href={`/admin/automations/${automation.id}/builder`} data-testid="editor-open-builder">
              {l["editor.open_builder"]}
            </Link>
          </Button>
        ) : null}
        {dirty ? <span className="text-sm text-muted-foreground">{l["editor.unsaved"]}</span> : null}
      </div>
      {message ? (
        <Alert variant={message.kind === "error" ? "destructive" : "default"} role={message.kind === "error" ? "alert" : "status"} data-testid="editor-message">
          <AlertDescription>{message.text}</AlertDescription>
        </Alert>
      ) : null}
      <section aria-labelledby="editor-issues" className="grid gap-2 rounded-md border p-3" data-testid="editor-issues">
        <h2 id="editor-issues" className="text-sm font-semibold">
          {l["editor.issues_title"]}
        </h2>
        {issues.length === 0 ? (
          <p className="text-sm">{l["editor.no_issues"]}</p>
        ) : (
          <ul className="grid gap-1 text-sm">
            {views.map((i, n) => (
              <li key={n} data-issue={i.code} className={i.severity === "error" ? "text-destructive" : "text-amber-700 dark:text-amber-400"}>
                <span className="font-medium">{i.severity === "error" ? l["editor.issue_error"] : l["editor.issue_warning"]}</span>
                {`: ${i.path ? `${i.path}: ` : ""}${i.text}`}
              </li>
            ))}
          </ul>
        )}
        {errorsCount === 0 && issues.length > 0 ? <p className="text-sm">{l["editor.no_issues"]}</p> : null}
      </section>

      <Tabs value={tab} onValueChange={(v) => {
        if (v === "json") setJson(JSON.stringify(def, null, 2));
        setTab(v);
      }}>
        <TabsList>
          <TabsTrigger value="form" disabled={!isFormShaped(def)}>
            {l["editor.tab_form"]}
          </TabsTrigger>
          <TabsTrigger value="json">{l["editor.tab_json"]}</TabsTrigger>
        </TabsList>
        <TabsContent value="form" className="grid gap-4">
          {!isFormShaped(def) ? <p className="text-sm">{l["editor.json_unreadable"]}</p> : null}
          <Card>
            <CardHeader>
              <CardTitle>{l["editor.settings"]}</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3 sm:grid-cols-2">
              <Field label={l["editor.name"] ?? ""}>{(id) => <Input id={id} disabled={disabled} value={settings.name} onChange={(e) => setSetting({ name: e.target.value })} />}</Field>
              <Field label={l["editor.group"] ?? ""}>
                {(id) => (
                  <select id={id} className={selectClass} disabled={disabled} value={settings.groupKey} onChange={(e) => setSetting({ groupKey: e.target.value })}>
                    {groups.map((g) => (
                      <option key={g.key} value={g.key}>
                        {g.name}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
              <Field label={l["editor.description"] ?? ""}>
                {(id) => <Textarea id={id} rows={2} disabled={disabled} value={settings.description ?? ""} onChange={(e) => setSetting({ description: e.target.value || null })} />}
              </Field>
              <Field label={l["editor.priority"] ?? ""}>
                {(id) => <Input id={id} type="number" min={0} max={1000} disabled={disabled} value={String(settings.priority)} onChange={(e) => setSetting({ priority: Math.min(1000, Math.max(0, Math.trunc(Number(e.target.value) || 0))) })} />}
              </Field>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" disabled={disabled} checked={settings.isMarketing} onChange={(e) => setSetting({ isMarketing: e.target.checked, purpose: e.target.checked ? (settings.purpose ?? "newsletter") : settings.purpose })} />
                {l["editor.marketing"]}
              </label>
              <Field label={l["editor.purpose"] ?? ""} {...(settings.purpose === "b2b" ? { hint: l["editor.purpose_b2b_hint"] } : {})}>
                {(id, describedBy) => (
                  <select id={id} aria-describedby={describedBy} className={selectClass} disabled={disabled} value={settings.purpose ?? ""} onChange={(e) => setSetting({ purpose: (e.target.value || null) as EditorAutomation["purpose"] })}>
                    {settings.isMarketing ? null : <option value="">{l["editor.purpose_none"]}</option>}
                    {PURPOSES.map((p) => (
                      <option key={p} value={p}>
                        {l[`purpose.${p}`]}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
              {b2bEmailSteps.length ? (
                <Alert className="sm:col-span-2" data-testid="editor-b2b-email">
                  <AlertDescription>{`${l["editor.b2b_email_steps"] ?? ""} ${b2bEmailSteps.filter(Boolean).join(", ")}`.trim()}</AlertDescription>
                </Alert>
              ) : null}
            </CardContent>
          </Card>
          {isFormShaped(def) ? (
            <>
              <TriggerCard {...cardProps} />
              <TimingCard {...cardProps} />
              <AudienceCard {...cardProps} />
              <ReEntryExitCard {...cardProps} />
              <Card>
                <CardHeader>
                  <CardTitle>{l["editor.steps"]}</CardTitle>
                </CardHeader>
                <CardContent className="grid gap-2">
                  <IssueList issues={views.filter((i) => i.path === "steps")} />
                  <StepForms steps={steps} onChange={(s) => set({ steps: s })} l={l} options={options} issues={views} disabled={disabled} />
                </CardContent>
              </Card>
            </>
          ) : null}
        </TabsContent>
        <TabsContent value="json" className="grid gap-2">
          <FormField label={l["editor.json_label"]} hint={l["editor.json_hint"]} error={jsonError}>
            <Textarea className="min-h-96 font-mono text-xs" spellCheck={false} disabled={disabled} value={json} onChange={(e) => setJson(e.target.value)} data-testid="editor-json" />
          </FormField>
          {canEdit ? (
            <Button type="button" variant="outline" className="w-fit" onClick={applyJson}>
              {l["editor.json_apply"]}
            </Button>
          ) : null}
        </TabsContent>
      </Tabs>
    </div>
  );
}

/** Slug from a name: lowercase ASCII, digits and single hyphens. */
export function slugify(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

/** `/admin/automations/new`: name, slug (from the name), group, marketing and purpose, priority, duplicate from. */
export function NewAutomationForm({
  groups,
  automations,
  labels: l,
}: {
  groups: { key: string; name: string; isExclusive: boolean }[];
  automations: { id: string; slug: string; name: string }[];
  labels: Labels;
}) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [isMarketing, setIsMarketing] = useState(true);
  const [purpose, setPurpose] = useState<string>("newsletter");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const fieldError = (k: string) => (fields[k] ? (l[`errors.${fields[k]}`] ?? l["errors.validation"]) : null);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const purposeValue = formStr(f, "purpose");
    const duplicateOfId = formStr(f, "duplicateOfId");
    const description = formStr(f, "description").trim();
    setBusy(true);
    setError(null);
    setFields({});
    try {
      const r = await createAutomation({
        slug,
        name,
        groupKey: formStr(f, "groupKey"),
        isMarketing,
        priority: Number(f.get("priority") ?? 100),
        ...(description ? { description } : {}),
        ...(purposeValue ? { purpose: purposeValue } : {}),
        ...(duplicateOfId ? { duplicateOfId } : {}),
      });
      if (r.ok) router.push(`/admin/automations/${r.data.id}/edit`);
      else {
        setError(errorText(r.error, l));
        setFields(r.error.fields ?? {});
      }
    } catch {
      setError(l["errors.generic"] ?? "");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="grid max-w-2xl gap-4" data-testid="new-automation-form">
      <FormField label={l["new.name"]} required error={fieldError("name")}>
        <Input
          name="name"
          value={name}
          maxLength={160}
          onChange={(e) => {
            setName(e.target.value);
            if (!slugEdited) setSlug(slugify(e.target.value));
          }}
        />
      </FormField>
      <FormField label={l["new.slug"]} hint={l["new.slug_hint"]} required error={fieldError("slug")}>
        <Input
          name="slug"
          value={slug}
          className="font-mono"
          onChange={(e) => {
            setSlug(e.target.value);
            setSlugEdited(true);
          }}
        />
      </FormField>
      <FormField label={l["new.description_field"]}>
        <Textarea name="description" rows={2} maxLength={2000} />
      </FormField>
      <FormField label={l["new.group"]} hint={l["new.group_hint"]} required error={fieldError("groupKey")}>
        <select name="groupKey" className={selectClass} defaultValue={groups.find((g) => !g.isExclusive)?.key ?? groups[0]?.key}>
          {groups.map((g) => (
            <option key={g.key} value={g.key}>
              {g.isExclusive ? `${g.name} (${l["list.exclusive"]})` : g.name}
            </option>
          ))}
        </select>
      </FormField>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          name="isMarketing"
          className="mt-1"
          checked={isMarketing}
          onChange={(e) => {
            setIsMarketing(e.target.checked);
            setPurpose(e.target.checked ? "newsletter" : "");
          }}
        />
        <span>
          {l["new.marketing"]}
          <span className="block text-xs text-muted-foreground">{l["new.marketing_hint"]}</span>
        </span>
      </label>
      <FormField label={l["new.purpose"]} required={isMarketing} error={fieldError("purpose")} {...(purpose === "b2b" ? { hint: l["new.purpose_b2b_hint"] } : {})}>
        <select name="purpose" className={selectClass} value={purpose} onChange={(e) => setPurpose(e.target.value)}>
          {isMarketing ? null : <option value="">{l["new.purpose_none"]}</option>}
          {PURPOSES.map((p) => (
            <option key={p} value={p}>
              {l[`purpose.${p}`]}
            </option>
          ))}
        </select>
      </FormField>
      <FormField label={l["new.priority"]} hint={l["new.priority_hint"]} error={fieldError("priority")}>
        <Input name="priority" type="number" min={0} max={1000} defaultValue={100} />
      </FormField>
      <FormField label={l["new.duplicate_from"]} hint={l["new.duplicate_hint"]}>
        <select name="duplicateOfId" className={selectClass} defaultValue="">
          <option value="">{l["new.duplicate_none"]}</option>
          {automations.map((a) => (
            <option key={a.id} value={a.id}>
              {`${a.name} (${a.slug})`}
            </option>
          ))}
        </select>
      </FormField>
      {error ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <Button type="submit" disabled={busy} className="w-fit">
        {l["new.create"]}
      </Button>
    </form>
  );
}
