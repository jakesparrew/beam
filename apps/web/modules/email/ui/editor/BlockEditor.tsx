"use client";
/**
 * The three-pane block editor of `/admin/templates/[id]` (email spec section 5): the block
 * palette, the canvas per locale tab with a completeness badge, and the inspector of the selected
 * block; subject and preheader per locale; the token and merge-field picker; accessibility and
 * card warnings per block; autosave every 10 seconds; publish (`email.send`) with the validation
 * list (`locale: path: problem`, scrolled into view); live preview as Lead, Customer or Member;
 * test send. A stale draft answers `conflict` and the editor offers a reload.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Alert, AlertDescription, AlertTitle, Badge, Button, Input, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Tabs, TabsList, TabsTrigger } from "@beam/ui";
import type { Block, BlockDocument, BlockType, LocaleCompleteness } from "@beam/core/email";
import { LOCALES, type Locale, type LocalizedText } from "@beam/core/i18n";
import { previewTemplate, publishTemplateVersion, saveTemplateDraft, sendTestEmail, uploadImage } from "../../actions";
import { BlockCanvas, cloneWithNewIds, findBlock, lab, newBlock, replaceBlock, type EditorLabels } from "./BlockCanvas";
import { BlockInspector } from "./BlockInspector";
import { BlockPalette } from "./BlockPalette";
import { PreviewFrame, type PreviewData } from "./PreviewFrame";
import { TestSendDialog } from "./TestSendDialog";
import { TokenPicker } from "./TokenPicker";

/** Autosave interval of the draft (spec section 5). */
export const AUTOSAVE_MS = 10_000;

export type BlockEditorProps = {
  templateId: string;
  canPublish: boolean;
  canReadPersons: boolean;
  initial: {
    subject: LocalizedText;
    preheader: LocalizedText;
    document: BlockDocument;
    draftUpdatedAt: string;
    completeness: LocaleCompleteness[];
    hasDraft: boolean;
    hasCurrent: boolean;
  };
  mergeFields: readonly string[];
  localeNames: Record<Locale, string>;
  defaultTo: string;
  labels: EditorLabels;
};

type Problem = { key: string; value: string };
type Warn = { code: string; locale: string; blockId?: string; detail?: string };

function issueText(labels: EditorLabels, p: Problem): string {
  const [locale, ...rest] = p.key.split(":");
  const path = rest.join(":");
  const problem = labels[`problem_${p.value}`] ? lab(labels, `problem_${p.value}`) : p.value;
  return path ? `${locale}: ${path}: ${problem}` : `${p.key}: ${problem}`;
}

export function BlockEditor(props: BlockEditorProps) {
  const { labels, templateId } = props;
  const router = useRouter();
  const [subject, setSubject] = useState<LocalizedText>(props.initial.subject);
  const [preheader, setPreheader] = useState<LocalizedText>(props.initial.preheader);
  const [doc, setDoc] = useState<BlockDocument>(props.initial.document);
  const [locale, setLocale] = useState<Locale>("nl-BE");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [draftUpdatedAt, setDraftUpdatedAt] = useState<string>(props.initial.draftUpdatedAt);
  const [completeness, setCompleteness] = useState<LocaleCompleteness[]>(props.initial.completeness);
  const [problems, setProblems] = useState<{ title: string; items: Problem[] } | null>(null);
  const [warnings, setWarnings] = useState<Warn[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [persona, setPersona] = useState<"lead" | "customer" | "member">("lead");
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [hasDraft, setHasDraft] = useState(props.initial.hasDraft);
  const problemsRef = useRef<HTMLDivElement>(null);

  const blocks = doc.locales[locale] ?? [];
  const setBlocks = (next: Block[]) => {
    setDoc((d) => ({ ...d, locales: { ...d.locales, [locale]: next } }));
    setDirty(true);
  };
  const selected = selectedId ? findBlock(blocks, selectedId) : null;

  const save = useCallback(async (): Promise<string | null> => {
    if (conflict) return null;
    setSaving(true);
    try {
      const result = await saveTemplateDraft({ templateId, draftUpdatedAt, subject, preheader, document: doc });
      if (result.ok) {
        const at = new Date(result.data.updatedAt).toISOString();
        setDraftUpdatedAt(at);
        setCompleteness(result.data.completeness);
        setDirty(false);
        setHasDraft(true);
        return at;
      }
      if (result.error.code === "conflict") setConflict(true);
      else setProblems({ title: lab(labels, "save_failed"), items: Object.entries(result.error.fields ?? { [result.error.message]: result.error.message }).map(([key, value]) => ({ key, value })) });
      return null;
    } finally {
      setSaving(false);
    }
  }, [conflict, templateId, draftUpdatedAt, subject, preheader, doc, labels]);

  useEffect(() => {
    if (!dirty || saving || conflict) return;
    const timer = setTimeout(() => void save(), AUTOSAVE_MS);
    return () => clearTimeout(timer);
  }, [dirty, saving, conflict, save]);

  async function publish() {
    setProblems(null);
    setNotice(null);
    const at = dirty ? await save() : draftUpdatedAt;
    if (!at) return;
    const result = await publishTemplateVersion({ templateId, draftUpdatedAt: at });
    if (result.ok) {
      setWarnings(result.data.warnings);
      setNotice(lab(labels, "published", { version: result.data.version }));
      setHasDraft(false);
      router.refresh();
      return;
    }
    if (result.error.code === "conflict") return setConflict(true);
    setProblems({
      title: lab(labels, `publish_${result.error.message}`),
      items: Object.entries(result.error.fields ?? {}).map(([key, value]) => ({ key, value })),
    });
    requestAnimationFrame(() => problemsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }

  async function refreshPreview() {
    if (dirty && !(await save())) return;
    setPreviewing(true);
    try {
      const result = await previewTemplate({ templateId, use: "draft", locale, as: { sample: persona } });
      if (result.ok && result.data) {
        setPreview(result.data);
        setWarnings(result.data.warnings);
      }
    } finally {
      setPreviewing(false);
    }
  }

  const addTop = (type: BlockType) => {
    const b = newBlock(type);
    setBlocks([...blocks, b]);
    setSelectedId(b.id);
  };
  const copyFrom = (from: Locale) => setBlocks((doc.locales[from] ?? []).map((b) => cloneWithNewIds(b)));
  const warnedIds = new Set(warnings.filter((w) => w.locale === locale && w.blockId).map((w) => w.blockId!));
  const blockWarnings = selected ? [...new Set(warnings.filter((w) => w.blockId === selected.id && w.locale === locale).map((w) => lab(labels, `warning_${w.code}`)))] : [];
  const missingOf = (l: Locale) => completeness.find((c) => c.locale === l)?.missing.length ?? 0;
  const disabled = conflict;

  return (
    <div className="grid gap-4" data-testid="block-editor">
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
        <Button type="button" onClick={() => void save()} disabled={saving || disabled || !dirty} data-testid="save-draft">
          {saving ? lab(labels, "saving") : lab(labels, "save_draft")}
        </Button>
        {props.canPublish ? (
          <Button type="button" variant="default" onClick={() => void publish()} disabled={saving || disabled} data-testid="publish">
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
          disabled={disabled}
        />
        <Button variant="ghost" asChild>
          <Link href={`/admin/templates/${templateId}/preview`}>{lab(labels, "open_preview")}</Link>
        </Button>
        <span className="text-xs text-muted-foreground" aria-live="polite">
          {dirty ? lab(labels, "unsaved") : lab(labels, "saved")}
        </span>
      </div>
      {notice ? (
        <Alert>
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      ) : null}
      {problems ? (
        <div ref={problemsRef}>
          <Alert variant="destructive" data-testid="publish-problems">
            <AlertTitle>{problems.title}</AlertTitle>
            <AlertDescription>
              <ul className="list-disc pl-4 text-sm">
                {problems.items.map((p) => (
                  <li key={p.key}>{issueText(labels, p)}</li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        </div>
      ) : null}
      <Tabs value={locale} onValueChange={(v) => (setLocale(v as Locale), setSelectedId(null))}>
        <TabsList>
          {LOCALES.map((l) => (
            <TabsTrigger key={l} value={l} data-locale={l}>
              {props.localeNames[l]}{" "}
              {missingOf(l) ? <Badge variant="destructive">{lab(labels, "missing_count", { count: missingOf(l) })}</Badge> : <Badge variant="secondary">{lab(labels, "complete")}</Badge>}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      <div className="grid gap-3 sm:grid-cols-2">
        {(
          [
            ["subject", subject, setSubject],
            ["preheader", preheader, setPreheader],
          ] as const
        ).map(([key, value, set]) => (
          <div key={key} className="grid gap-1">
            <Label htmlFor={`field-${key}`}>{lab(labels, key)}</Label>
            <Input
              id={`field-${key}`}
              value={value[locale] ?? ""}
              disabled={disabled}
              onChange={(e) => (set({ ...value, [locale]: e.target.value }), setDirty(true))}
            />
            <div>
              <TokenPicker mergeFields={props.mergeFields} labels={labels} disabled={disabled} onInsert={(t) => (set({ ...value, [locale]: `${value[locale] ?? ""}${t}` }), setDirty(true))} />
            </div>
          </div>
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-[12rem_1fr_20rem]">
        <aside>
          <BlockPalette onAdd={addTop} labels={labels} disabled={disabled} />
        </aside>
        <section className="grid content-start gap-3">
          <BlockCanvas blocks={blocks} selectedId={selectedId} onSelect={setSelectedId} onChange={setBlocks} warnedIds={warnedIds} labels={labels} disabled={disabled} />
          {!blocks.length ? (
            <div className="flex flex-wrap gap-2">
              {LOCALES.filter((l) => l !== locale && (doc.locales[l]?.length ?? 0) > 0).map((l) => (
                <Button key={l} type="button" size="sm" variant="outline" disabled={disabled} onClick={() => copyFrom(l)}>
                  {lab(labels, "copy_from", { locale: props.localeNames[l] })}
                </Button>
              ))}
            </div>
          ) : null}
        </section>
        <aside>
          <BlockInspector
            block={selected}
            onChange={(b) => setBlocks(replaceBlock([...blocks], b.id, b))}
            labels={labels}
            mergeFields={props.mergeFields}
            warnings={blockWarnings}
            uploadImage={uploadImage}
            disabled={disabled}
          />
        </aside>
      </div>
      <section className="grid gap-3 border-t pt-4">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-base font-semibold">{lab(labels, "live_preview")}</h2>
          <Select value={persona} onValueChange={(v) => setPersona(v as typeof persona)}>
            <SelectTrigger className="w-44" aria-label={lab(labels, "preview_as")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="lead">{lab(labels, "persona_lead")}</SelectItem>
              <SelectItem value="customer">{lab(labels, "persona_customer")}</SelectItem>
              <SelectItem value="member">{lab(labels, "persona_member")}</SelectItem>
            </SelectContent>
          </Select>
          <Button type="button" variant="outline" size="sm" onClick={() => void refreshPreview()} disabled={previewing || disabled} data-testid="refresh-preview">
            {lab(labels, "refresh_preview")}
          </Button>
        </div>
        <PreviewFrame preview={preview} labels={labels} loading={previewing} />
      </section>
    </div>
  );
}
