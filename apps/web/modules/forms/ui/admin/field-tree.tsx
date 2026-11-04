"use client";

/**
 * The builder (forms spec section 5 `/admin/forms/[formId]/build`; forms-P5): three panes, the
 * section and field tree (drag, or the move buttons, to reorder), the field or section editor, and
 * the tabs Logic, Endings and Settings, with the live issue list and the completeness badge per
 * locale. `useDraft` autosaves through `saveDraft` 5 seconds after the last change and turns a
 * stale `expectedHash` into the "Someone else saved this draft" dialog; the scoring page uses the
 * same hook. Publish opens a dialog with the change note and the issues.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { defaultSensitive, FIELD_TYPES, validateForPublish, type Field, type FieldType, type FormDefinition, type FormKind, type FormScoring, type PublishIssue, type Section } from "@beam/core/forms";
import type { Locale, LocalizedText } from "@beam/core/i18n";
import { Badge, Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, LocalizedInput, Tabs, TabsContent, TabsList, TabsTrigger, Textarea, toast } from "@beam/ui";
import { publishVersion, saveDraft } from "../../actions";
import { ConditionBuilder, selectClass, type ConditionDimensionRef, type ConditionFieldRef } from "./condition-builder";
import { EndingEditor } from "./ending-editor";
import { FieldEditor, textLabels } from "./field-editor";
import { CompletenessBadges, IssuesPanel, lbl, type Labels } from "./issues-panel";
import { LogicEditor, SettingsEditor } from "./logic-editor";

export const AUTOSAVE_MS = 5000;

export type DraftInput = { formId: string; versionId: string; definition: FormDefinition; scoring: FormScoring; locales: Locale[]; hash: string };
export type SaveStatus = "saved" | "pending" | "saving" | "conflict" | "error";

/** Draft state with autosave (5 s after the last change) and the live issues of `validateForPublish`. */
export function useDraft(initial: DraftInput, kind: FormKind, labels: Labels) {
  const [content, setContent] = useState({ definition: initial.definition, scoring: initial.scoring, locales: initial.locales });
  const [status, setStatus] = useState<SaveStatus>("saved");
  const hash = useRef(initial.hash);
  const notes = useRef<string[]>([]);
  const first = useRef(true);
  const latest = useRef(content);
  useEffect(() => {
    latest.current = content;
  }, [content]);

  const save = useCallback(async () => {
    setStatus("saving");
    const c = latest.current;
    try {
      const r = await saveDraft({ formId: initial.formId, versionId: initial.versionId, ...c, expectedHash: hash.current, ...(notes.current.length ? { changeNote: notes.current.join("; ") } : {}) });
      if (r.ok) {
        hash.current = r.data.definitionHash;
        setStatus(latest.current === c ? "saved" : "pending");
      } else if (r.error.code === "conflict") setStatus("conflict");
      else {
        setStatus("error");
        toast.error(lbl(labels, `builder.error.${r.error.code}`));
      }
    } catch {
      setStatus("error");
      toast.error(lbl(labels, "builder.error.internal"));
    }
  }, [initial.formId, initial.versionId, labels]);

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    setStatus((s) => (s === "conflict" ? s : "pending"));
    const timer = setTimeout(() => void save(), AUTOSAVE_MS);
    return () => clearTimeout(timer);
  }, [content, save]);

  const issues = useMemo(() => validateForPublish(kind, content.definition, content.scoring, content.locales), [kind, content]);
  return {
    ...content,
    status,
    issues,
    save,
    setDefinition: (definition: FormDefinition) => setContent((c) => ({ ...c, definition })),
    setScoring: (scoring: FormScoring) => setContent((c) => ({ ...c, scoring })),
    setLocales: (locales: Locale[]) => setContent((c) => ({ ...c, locales })),
    addNote: (note: string) => void notes.current.push(note),
  };
}

export function SaveIndicator({ status, labels }: { status: SaveStatus; labels: Labels }) {
  return (
    <span role="status" aria-live="polite" className="text-sm text-muted-foreground">
      {lbl(labels, `builder.status.${status}`)}
    </span>
  );
}

/** "Someone else saved this draft" with a reload button. */
export function ConflictDialog({ open, labels }: { open: boolean; labels: Labels }) {
  return (
    <Dialog open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{lbl(labels, "builder.conflict_title")}</DialogTitle>
          <DialogDescription>{lbl(labels, "builder.conflict_body")}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" onClick={() => window.location.reload()}>
            {lbl(labels, "builder.reload")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PublishDialog({ issues, labels, onPublish, disabled }: { issues: PublishIssue[]; labels: Labels; onPublish: (note: string) => Promise<boolean>; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const blocked = issues.some((i) => i.level === "error");
  return (
    <>
      <Button type="button" onClick={() => setOpen(true)} disabled={disabled}>
        {lbl(labels, "builder.publish")}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent closeLabel={lbl(labels, "builder.cancel")}>
          <DialogHeader>
            <DialogTitle>{lbl(labels, "builder.publish_title")}</DialogTitle>
            <DialogDescription>{lbl(labels, blocked ? "builder.publish_blocked" : "builder.publish_body")}</DialogDescription>
          </DialogHeader>
          <IssuesPanel issues={issues} labels={labels} />
          <label className="grid gap-1 text-sm">
            {lbl(labels, "builder.change_note")}
            <Textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
          </label>
          <DialogFooter>
            <Button
              type="button"
              disabled={blocked || busy || !note.trim()}
              onClick={() => {
 void (async () => {
                setBusy(true);
                if (await onPublish(note.trim())) setOpen(false);
                setBusy(false);
              })();
}}
            >
              {lbl(labels, "builder.publish_confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ---------------------------------------------------------------------------
// Tree
// ---------------------------------------------------------------------------

type Selection = { kind: "field"; key: string } | { kind: "section"; key: string } | null;

function newField(type: FieldType, key: string, kind: FormKind): Field {
  const base = { key, label: {} as LocalizedText, required: false, sensitive: defaultSensitive(kind, type) };
  switch (type) {
    case "single_choice":
    case "dropdown":
    case "multiple_choice":
      return { ...base, type, options: [{ key: "option_1", label: {} }, { key: "option_2", label: {} }] };
    case "rating":
      return { ...base, type, scale: 5 };
    case "consent":
      return { ...base, type, purpose: "newsletter", wording: {} };
    case "acknowledgement":
      return { ...base, type, required: true, text: {} };
    case "hidden":
      return { ...base, type, from: "query", param: key };
    case "utm":
      return { ...base, type, param: "utm_source" };
    default:
      return { ...base, type };
  }
}

function uniqueKey(base: string, taken: (k: string) => boolean): string {
  let n = 1;
  while (taken(`${base}_${n}`)) n++;
  return `${base}_${n}`;
}

export type FieldTreeProps = {
  definition: FormDefinition;
  onChange: (d: FormDefinition) => void;
  selected: Selection;
  onSelect: (s: Selection) => void;
  kind: FormKind;
  labels: Labels;
  locale: Locale;
};

/** Sections and their fields; drag a field onto another field or a section to move it. */
export function FieldTree({ definition: d, onChange, selected, onSelect, kind, labels, locale }: FieldTreeProps) {
  const [dragging, setDragging] = useState<string | null>(null);
  const [addType, setAddType] = useState<FieldType>("short_text");
  const title = (s: Section, i: number) => s.title?.[locale] || lbl(labels, "builder.section_n", { n: i + 1 });
  const moveField = (key: string, toSection: string, before?: string) => {
    if (key === before) return;
    const sections = d.sections.map((s) => ({ ...s, fieldKeys: s.fieldKeys.filter((k) => k !== key) }));
    const target = sections.find((s) => s.key === toSection);
    if (!target) return;
    const at = before ? target.fieldKeys.indexOf(before) : -1;
    target.fieldKeys.splice(at < 0 ? target.fieldKeys.length : at, 0, key);
    onChange({ ...d, sections });
  };
  const shift = (key: string, by: -1 | 1) => {
    const s = d.sections.find((x) => x.fieldKeys.includes(key))!;
    const i = s.fieldKeys.indexOf(key);
    const j = i + by;
    if (j < 0 || j >= s.fieldKeys.length) return;
    const keys = [...s.fieldKeys];
    [keys[i], keys[j]] = [keys[j]!, keys[i]!];
    onChange({ ...d, sections: d.sections.map((x) => (x.key === s.key ? { ...x, fieldKeys: keys } : x)) });
  };
  const shiftSection = (i: number, by: -1 | 1) => {
    const j = i + by;
    if (j < 0 || j >= d.sections.length) return;
    const list = [...d.sections];
    [list[i], list[j]] = [list[j]!, list[i]!];
    onChange({ ...d, sections: list });
  };
  const addField = (sectionKey: string) => {
    const key = uniqueKey(addType, (k) => k in d.fields);
    onChange({ ...d, fields: { ...d.fields, [key]: newField(addType, key, kind) }, sections: d.sections.map((s) => (s.key === sectionKey ? { ...s, fieldKeys: [...s.fieldKeys, key] } : s)) });
    onSelect({ kind: "field", key });
  };
  return (
    <nav aria-label={lbl(labels, "builder.tree")} className="grid gap-3">
      <label className="grid gap-1 text-xs">
        {lbl(labels, "builder.add_field_type")}
        <select className={selectClass} value={addType} onChange={(e) => setAddType(e.target.value as FieldType)}>
          {FIELD_TYPES.map((t) => (
            <option key={t} value={t}>
              {lbl(labels, `builder.type.${t}`)}
            </option>
          ))}
        </select>
      </label>
      {d.sections.map((s, si) => (
        <div key={s.key} className="rounded-md border" onDragOver={(e) => e.preventDefault()} onDrop={() => dragging && moveField(dragging, s.key)}>
          <div className="flex items-center gap-1 border-b p-2">
            <button type="button" className={`flex-1 text-left text-sm font-medium ${selected?.kind === "section" && selected.key === s.key ? "underline" : ""}`} onClick={() => onSelect({ kind: "section", key: s.key })}>
              {title(s, si)}
            </button>
            <Button type="button" variant="ghost" size="sm" aria-label={lbl(labels, "builder.move_up")} disabled={si === 0} onClick={() => shiftSection(si, -1)}>
              ↑
            </Button>
            <Button type="button" variant="ghost" size="sm" aria-label={lbl(labels, "builder.move_down")} disabled={si === d.sections.length - 1} onClick={() => shiftSection(si, 1)}>
              ↓
            </Button>
          </div>
          <ul className="grid gap-1 p-2">
            {s.fieldKeys.map((k) => {
              const f = d.fields[k];
              return (
                <li key={k} draggable onDragStart={() => setDragging(k)} onDragEnd={() => setDragging(null)} onDragOver={(e) => e.preventDefault()} onDrop={(e) => (e.stopPropagation(), dragging && moveField(dragging, s.key, k))} className="flex items-center gap-1">
                  <button type="button" className={`flex-1 truncate rounded px-2 py-1 text-left text-sm hover:bg-accent ${selected?.kind === "field" && selected.key === k ? "bg-accent" : ""}`} onClick={() => onSelect({ kind: "field", key: k })}>
                    {f?.label[locale] || k}
                    <span className="ml-2 text-xs text-muted-foreground">{f ? lbl(labels, `builder.type.${f.type}`) : ""}</span>
                    {f?.sensitive ? (
                      <Badge variant="warning" className="ml-1">
                        {lbl(labels, "builder.sensitive_badge")}
                      </Badge>
                    ) : null}
                  </button>
                  <Button type="button" variant="ghost" size="sm" aria-label={lbl(labels, "builder.move_up")} onClick={() => shift(k, -1)}>
                    ↑
                  </Button>
                  <Button type="button" variant="ghost" size="sm" aria-label={lbl(labels, "builder.move_down")} onClick={() => shift(k, 1)}>
                    ↓
                  </Button>
                </li>
              );
            })}
          </ul>
          <div className="border-t p-2">
            <Button type="button" variant="outline" size="sm" onClick={() => addField(s.key)}>
              {lbl(labels, "builder.add_field")}
            </Button>
          </div>
        </div>
      ))}
      <div>
        <Button type="button" variant="outline" onClick={() => onChange({ ...d, sections: [...d.sections, { key: uniqueKey("s", (k) => d.sections.some((s) => s.key === k)), fieldKeys: [] }] })}>
          {lbl(labels, "builder.add_section")}
        </Button>
      </div>
    </nav>
  );
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

export type FormBuilderProps = {
  draft: DraftInput;
  kind: FormKind;
  labels: Labels;
  locale: Locale;
  localeNames: Record<Locale, string>;
  canPublish: boolean;
  ctaWarnings: { endingKey: string; ctaKey: string; reason: string }[];
};

/** Fields in order with their section index; L4: a condition may reference only earlier fields. */
function orderedFields(d: FormDefinition): { field: Field; section: number }[] {
  return d.sections.flatMap((s, i) => s.fieldKeys.map((k) => d.fields[k]).filter((f): f is Field => !!f).map((field) => ({ field, section: i })));
}

export function FormBuilder({ draft, kind, labels, locale, localeNames, canPublish, ctaWarnings }: FormBuilderProps) {
  const router = useRouter();
  const s = useDraft(draft, kind, labels);
  const d = s.definition;
  const [selected, setSelected] = useState<Selection>(d.sections[0]?.fieldKeys[0] ? { kind: "field", key: d.sections[0].fieldKeys[0] } : d.sections[0] ? { kind: "section", key: d.sections[0].key } : null);
  const tl = textLabels(labels, localeNames);
  const ordered = useMemo(() => orderedFields(d), [d]);
  const ref = (f: Field): ConditionFieldRef => ({ key: f.key, label: f.label[locale] ?? f.key, type: f.type, ...("options" in f ? { options: f.options.map((o) => ({ key: o.key, label: o.label[locale] ?? o.key })) } : {}) });
  const dims: ConditionDimensionRef[] = s.scoring.dimensions.map((x) => ({ key: x.key, label: x.label[locale] ?? x.key, ranges: x.ranges.map((r) => ({ key: r.key, label: r.label[locale] ?? r.key })) }));
  const before = (key: string) => {
    const i = ordered.findIndex((o) => o.field.key === key);
    return ordered.slice(0, Math.max(i, 0)).map((o) => ref(o.field));
  };
  const sectionIndex = (key: string) => d.sections.findIndex((x) => x.key === key);
  const fieldsBeforeSection = (key: string, inclusive: boolean) => ordered.filter((o) => (inclusive ? o.section <= sectionIndex(key) : o.section < sectionIndex(key)));
  const sectionTitle = (key: string) => {
    const i = sectionIndex(key);
    return d.sections[i]?.title?.[locale] || lbl(labels, "builder.section_n", { n: i + 1 });
  };
  const focus = (path: string) => {
    const [head, key] = path.split(".");
    if (head === "fields" && key && d.fields[key]) setSelected({ kind: "field", key });
    else if (head === "sections" && key) setSelected({ kind: "section", key });
  };
  const selField = selected?.kind === "field" ? d.fields[selected.key] : undefined;
  const selSection = selected?.kind === "section" ? d.sections.find((x) => x.key === selected.key) : undefined;

  const removeField = (key: string) => {
    const { [key]: _gone, ...fields } = d.fields;
    s.setDefinition({ ...d, fields, sections: d.sections.map((x) => ({ ...x, fieldKeys: x.fieldKeys.filter((k) => k !== key) })) });
    setSelected(null);
  };
  const removeSection = (key: string) => {
    const sec = d.sections.find((x) => x.key === key);
    if (!sec || sec.fieldKeys.length) return;
    s.setDefinition({ ...d, sections: d.sections.filter((x) => x.key !== key), logic: d.logic.filter((r) => r.afterSection !== key) });
    setSelected(null);
  };

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <CompletenessBadges issues={s.issues} locales={s.locales} labels={labels} />
        <div className="flex items-center gap-3">
          <SaveIndicator status={s.status} labels={labels} />
          <Button type="button" variant="outline" onClick={() => void s.save()} disabled={s.status === "saving" || s.status === "conflict"}>
            {lbl(labels, "builder.save_now")}
          </Button>
          {canPublish ? (
            <PublishDialog
              issues={s.issues}
              labels={labels}
              disabled={s.status === "conflict"}
              onPublish={async (changeNote) => {
                if (s.status !== "saved") await s.save();
                const r = await publishVersion({ formId: draft.formId, versionId: draft.versionId, changeNote });
                if (r.ok) {
                  toast.success(lbl(labels, "builder.published", { version: r.data.version }));
                  router.push(`/admin/forms/${draft.formId}` as never);
                  return true;
                }
                toast.error(r.error.code === "validation" ? lbl(labels, "builder.publish_refused") : lbl(labels, `builder.error.${r.error.code}`));
                return false;
              }}
            />
          ) : null}
        </div>
      </div>
      <ConflictDialog open={s.status === "conflict"} labels={labels} />
      <div className="grid gap-4 lg:grid-cols-[18rem_minmax(0,1fr)_24rem]">
        <FieldTree definition={d} onChange={s.setDefinition} selected={selected} onSelect={setSelected} kind={kind} labels={labels} locale={locale} />
        <div className="grid content-start gap-4">
          {selField ? (
            <>
              <FieldEditor
                field={selField}
                onChange={(f) => s.setDefinition({ ...d, fields: { ...d.fields, [f.key]: f } })}
                onSensitiveUnticked={(key) => s.addNote(lbl(labels, "builder.note_unticked", { field: key }))}
                kind={kind}
                locales={s.locales}
                localeNames={localeNames}
                labels={labels}
                conditionFields={before(selField.key)}
                dimensions={dims}
                dimensionKeys={s.scoring.dimensions.map((x) => x.key)}
              />
              <div>
                <Button type="button" variant="destructive" size="sm" onClick={() => removeField(selField.key)}>
                  {lbl(labels, "builder.remove_field")}
                </Button>
              </div>
            </>
          ) : selSection ? (
            <div className="grid gap-4">
              <LocalizedInput name={`${selSection.key}-title`} value={selSection.title ?? {}} locales={s.locales} labels={tl("builder.section.title")} onChange={(title) => s.setDefinition({ ...d, sections: d.sections.map((x) => (x.key === selSection.key ? { ...x, title: title } : x)) })} />
              <LocalizedInput name={`${selSection.key}-description`} multiline value={selSection.description ?? {}} locales={s.locales} labels={tl("builder.section.description")} onChange={(description) => s.setDefinition({ ...d, sections: d.sections.map((x) => (x.key === selSection.key ? { ...x, description: description } : x)) })} />
              <ConditionBuilder legend={lbl(labels, "builder.section.visible_if")} value={selSection.visibleIf} onChange={(visibleIf) => s.setDefinition({ ...d, sections: d.sections.map((x) => (x.key === selSection.key ? { ...x, visibleIf } : x)) })} fields={fieldsBeforeSection(selSection.key, false).map((o) => ref(o.field))} dimensions={dims} labels={labels} />
              <div>
                <Button type="button" variant="destructive" size="sm" disabled={selSection.fieldKeys.length > 0 || d.sections.length === 1} onClick={() => removeSection(selSection.key)}>
                  {lbl(labels, "builder.remove_section")}
                </Button>
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">{lbl(labels, "builder.select_hint")}</p>
          )}
          <div className="grid gap-2">
            <LocalizedInput name="form-title" value={d.title} locales={s.locales} labels={tl("builder.form_title")} onChange={(title) => s.setDefinition({ ...d, title: title })} />
            <LocalizedInput name="form-intro" multiline value={d.intro ?? {}} locales={s.locales} labels={tl("builder.form_intro")} onChange={(intro) => s.setDefinition({ ...d, intro: intro })} />
          </div>
        </div>
        <div className="grid content-start gap-4">
          <Tabs defaultValue="logic">
            <TabsList>
              <TabsTrigger value="logic">{lbl(labels, "builder.tab_logic")}</TabsTrigger>
              <TabsTrigger value="endings">{lbl(labels, "builder.tab_endings")}</TabsTrigger>
              <TabsTrigger value="settings">{lbl(labels, "builder.tab_settings")}</TabsTrigger>
            </TabsList>
            <TabsContent value="logic">
              <LogicEditor
                definition={d}
                onChange={(logic) => s.setDefinition({ ...d, logic })}
                labels={labels}
                fieldsBefore={(key) => fieldsBeforeSection(key, true).filter((o) => !o.field.sensitive).map((o) => ref(o.field))}
                dimensions={dims}
                sectionTitle={sectionTitle}
              />
            </TabsContent>
            <TabsContent value="endings">
              <EndingEditor endings={d.endings} onChange={(endings) => s.setDefinition({ ...d, endings })} locales={s.locales} localeNames={localeNames} dimensionKeys={s.scoring.dimensions.map((x) => x.key)} labels={labels} brokenCtas={ctaWarnings} />
            </TabsContent>
            <TabsContent value="settings">
              <SettingsEditor settings={d.settings} onChange={(settings) => s.setDefinition({ ...d, settings })} locales={s.locales} onLocalesChange={s.setLocales} localeNames={localeNames} labels={labels} />
            </TabsContent>
          </Tabs>
          <IssuesPanel issues={s.issues} labels={labels} onSelect={focus} />
        </div>
      </div>
    </div>
  );
}
