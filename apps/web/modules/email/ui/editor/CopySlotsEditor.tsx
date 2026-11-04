"use client";
/**
 * Copy slots editor of a code-backed transactional template (email spec rule 14, section 5):
 * subject, preheader and every editable text slot of the react-email component per locale with
 * `LocalizedInput`; an empty slot keeps the owning module's catalogue default (shown as the
 * placeholder text below the field). Save draft (autosave every 10 seconds), publish with
 * `email.send`, test send, and the live preview of the component with its sample props.
 */
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Alert, AlertDescription, AlertTitle, Button, LocalizedInput } from "@beam/ui";
import type { LocaleCompleteness } from "@beam/core/email";
import { LOCALES, type Locale, type LocalizedText } from "@beam/core/i18n";
import { previewTemplate, publishTemplateVersion, saveTemplateDraft, sendTestEmail } from "../../actions";
import { lab, type EditorLabels } from "./BlockCanvas";
import { AUTOSAVE_MS } from "./BlockEditor";
import { PreviewFrame, type PreviewData } from "./PreviewFrame";
import { TestSendDialog } from "./TestSendDialog";

export type CopySlotsEditorProps = {
  templateId: string;
  canPublish: boolean;
  canReadPersons: boolean;
  initial: {
    subject: LocalizedText;
    preheader: LocalizedText;
    copy: Record<string, LocalizedText>;
    draftUpdatedAt: string;
    completeness: LocaleCompleteness[];
    hasDraft: boolean;
    hasCurrent: boolean;
  };
  /** Editable slots (the `subject` and `preheader` slots are edited as subject and preheader). */
  slots: readonly string[];
  slotDefaults: Record<string, LocalizedText>;
  localeNames: Record<Locale, string>;
  defaultTo: string;
  labels: EditorLabels;
};

export function CopySlotsEditor(props: CopySlotsEditorProps) {
  const { labels, templateId } = props;
  const router = useRouter();
  const [subject, setSubject] = useState<LocalizedText>(props.initial.subject);
  const [preheader, setPreheader] = useState<LocalizedText>(props.initial.preheader);
  const [copy, setCopy] = useState<Record<string, LocalizedText>>(props.initial.copy);
  const [draftUpdatedAt, setDraftUpdatedAt] = useState(props.initial.draftUpdatedAt);
  const [completeness, setCompleteness] = useState(props.initial.completeness);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [problems, setProblems] = useState<string[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [locale, setLocale] = useState<Locale>("nl-BE");
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [hasDraft, setHasDraft] = useState(props.initial.hasDraft);
  const slots = props.slots.filter((s) => s !== "subject" && s !== "preheader");
  const localeLabels = (field: string) => ({ field, locales: props.localeNames, missing: lab(labels, "missing"), complete: lab(labels, "complete") });

  const save = useCallback(async (): Promise<string | null> => {
    setSaving(true);
    try {
      const result = await saveTemplateDraft({ templateId, draftUpdatedAt, subject, preheader, copy });
      if (result.ok) {
        const at = new Date(result.data.updatedAt).toISOString();
        setDraftUpdatedAt(at);
        setCompleteness(result.data.completeness);
        setDirty(false);
        setHasDraft(true);
        return at;
      }
      if (result.error.code === "conflict") setConflict(true);
      else setProblems(Object.keys(result.error.fields ?? { [result.error.message]: "" }));
      return null;
    } finally {
      setSaving(false);
    }
  }, [templateId, draftUpdatedAt, subject, preheader, copy]);

  useEffect(() => {
    if (!dirty || saving || conflict) return;
    const timer = setTimeout(() => void save(), AUTOSAVE_MS);
    return () => clearTimeout(timer);
  }, [dirty, saving, conflict, save]);

  async function publish() {
    setProblems(null);
    const at = dirty ? await save() : draftUpdatedAt;
    if (!at) return;
    const result = await publishTemplateVersion({ templateId, draftUpdatedAt: at });
    if (result.ok) {
      setNotice(lab(labels, "published", { version: result.data.version }));
      setHasDraft(false);
      router.refresh();
    } else if (result.error.code === "conflict") setConflict(true);
    else setProblems(Object.keys(result.error.fields ?? { [result.error.message]: "" }));
  }

  async function refreshPreview(l: Locale = locale) {
    if (dirty && !(await save())) return;
    setPreviewing(true);
    try {
      const result = await previewTemplate({ templateId, use: "draft", locale: l });
      if (result.ok) setPreview(result.data);
    } finally {
      setPreviewing(false);
    }
  }

  const missing = completeness.flatMap((c) => c.missing.map((m) => `${c.locale}: ${m}`));
  return (
    <div className="grid gap-4" data-testid="copy-slots-editor">
      {conflict ? (
        <Alert variant="destructive">
          <AlertTitle>{lab(labels, "conflict")}</AlertTitle>
          <AlertDescription>
            <Button type="button" variant="outline" size="sm" onClick={() => window.location.reload()}>
              {lab(labels, "reload")}
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" onClick={() => void save()} disabled={saving || conflict || !dirty}>
          {saving ? lab(labels, "saving") : lab(labels, "save_draft")}
        </Button>
        {props.canPublish ? (
          <Button type="button" onClick={() => void publish()} disabled={saving || conflict}>
            {lab(labels, "publish")}
          </Button>
        ) : null}
        <TestSendDialog
          templateId={templateId}
          defaultTo={props.defaultTo}
          hasDraft={hasDraft}
          hasCurrent={props.initial.hasCurrent}
          canReadPersons={props.canReadPersons}
          localeNames={props.localeNames}
          sendTestEmail={sendTestEmail}
          labels={labels}
          disabled={conflict}
        />
        <span className="text-xs text-muted-foreground" aria-live="polite">
          {dirty ? lab(labels, "unsaved") : lab(labels, "saved")}
        </span>
      </div>
      {notice ? (
        <Alert>
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      ) : null}
      {problems?.length || missing.length ? (
        <Alert variant={problems?.length ? "destructive" : "default"}>
          <AlertTitle>{problems?.length ? lab(labels, "publish_template_incomplete") : lab(labels, "missing")}</AlertTitle>
          <AlertDescription>
            <ul className="list-disc pl-4 text-sm">
              {(problems?.length ? problems : missing).map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}
      <LocalizedInput name="subject" value={subject} locales={LOCALES} labels={localeLabels(lab(labels, "subject"))} onChange={(v) => (setSubject(v), setDirty(true))} disabled={conflict} />
      <LocalizedInput name="preheader" value={preheader} locales={LOCALES} labels={localeLabels(lab(labels, "preheader"))} onChange={(v) => (setPreheader(v), setDirty(true))} disabled={conflict} />
      {slots.map((slot) => (
        <div key={slot} className="grid gap-1">
          <LocalizedInput
            name={`copy.${slot}`}
            multiline
            value={copy[slot] ?? {}}
            locales={LOCALES}
            labels={localeLabels(slot)}
            onChange={(v) => (setCopy((c) => ({ ...c, [slot]: v })), setDirty(true))}
            disabled={conflict}
          />
          {props.slotDefaults[slot]?.[locale] ? <p className="text-xs text-muted-foreground">{lab(labels, "slot_default", { text: props.slotDefaults[slot]?.[locale] ?? "" })}</p> : null}
        </div>
      ))}
      <section className="grid gap-3 border-t pt-4">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-base font-semibold">{lab(labels, "live_preview")}</h2>
          {LOCALES.map((l) => (
            <Button key={l} type="button" size="sm" variant={l === locale ? "default" : "outline"} onClick={() => (setLocale(l), void refreshPreview(l))}>
              {props.localeNames[l]}
            </Button>
          ))}
          <Button type="button" variant="outline" size="sm" onClick={() => void refreshPreview()} disabled={previewing}>
            {lab(labels, "refresh_preview")}
          </Button>
        </div>
        <PreviewFrame preview={preview} labels={labels} loading={previewing} />
      </section>
    </div>
  );
}
