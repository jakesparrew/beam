"use client";
/**
 * The page editor (site spec section 5 `/admin/site/pages/[pageId]`, rules 3-16): locale tabs
 * with a completeness badge, title, path, excerpt, cover and blocks per locale, the SEO tab, page
 * settings (languages, material change, change summary), the issue list from `checkPublishable`,
 * the version history, and the controls Save draft (Ctrl+S), Preview, Publish now, Schedule,
 * Unpublish, Archive (with a redirect target) and Restore. Publish controls are hidden without
 * `site.publish`. A save conflict keeps the unsaved text in a side panel for copying (edge case 1).
 */
import { useCallback, useEffect, useMemo, useState, useTransition, type ReactNode } from "react";
import type { Route } from "next";
import { useRouter } from "next/navigation";
import { Alert, AlertDescription, Badge, Button, Checkbox, Input, Label, Tabs, TabsContent, TabsList, TabsTrigger, Textarea } from "@beam/ui";
import { LOCALES, type Locale, type LocalizedText } from "@beam/core/i18n";
import { EXCERPT_KINDS, issuesByLocale, LEGAL_KEYS, PAGE_KINDS, prefixFromLocale, type Block, type LegalKey, type Link, type PageKind, type PageSeo, type PublishIssue } from "@beam/core/site";
import { archivePage, cancelScheduledPublish, createPage, discardDraft, publishVersion, restoreArchivedPage, saveDraft, unpublishPage } from "../../actions/pages";
import type { EditorPickers, PageEditorData, SiteAdminLabels } from "../../queries/admin";
import { BlockListEditor } from "./block-list-editor";
import { LinkPicker, lbl, MediaPicker, OptionSelect, selectClass } from "./pickers";
import type { RichTextLabels } from "./rich-text-editor";
import { SeoFields } from "./seo-fields";
import { VersionHistory } from "./version-history";

type Content = {
  title: LocalizedText;
  paths: Partial<Record<Locale, string>>;
  blocks: Partial<Record<Locale, Block[]>>;
  seo: Partial<Record<Locale, PageSeo>>;
  excerpt: LocalizedText | null;
  coverMediaId: string | null;
  locales: Locale[];
  isMaterialChange: boolean;
  changeSummary: string | null;
};

export type PageEditorProps = {
  data: PageEditorData;
  pickers: EditorPickers;
  L: SiteAdminLabels;
  rich: RichTextLabels;
  canPublish: boolean;
  staffLocale: Locale;
  /** Slot for the Claude panel (site-P4). */
  claudePanel?: ReactNode;
};

const parseIssues = (fields: Record<string, string> | undefined): PublishIssue[] => {
  try {
    const v = JSON.parse(fields?.issues ?? "[]") as unknown;
    return Array.isArray(v) ? (v as PublishIssue[]) : [];
  } catch {
    return [];
  }
};

function initial(data: PageEditorData): Content {
  const v = data.draft ?? data.base;
  return {
    title: v?.title ?? {},
    paths: v?.paths ?? {},
    blocks: v?.blocks ?? {},
    seo: v?.seo ?? {},
    excerpt: v?.excerpt ?? null,
    coverMediaId: v?.coverMediaId ?? null,
    locales: v?.locales?.length ? v.locales : ["nl-BE"],
    isMaterialChange: data.draft?.isMaterialChange ?? false,
    changeSummary: data.draft?.changeSummary ?? null,
  };
}

export function PageEditor({ data, pickers, L, rich, canPublish, staffLocale, claudePanel }: PageEditorProps) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [content, setContent] = useState<Content>(() => initial(data));
  const [dirty, setDirty] = useState(false);
  const [draftId, setDraftId] = useState<string | null>(data.draft?.versionId ?? null);
  const [updatedAt, setUpdatedAt] = useState<string | null>(data.draft?.updatedAt ?? null);
  const [issues, setIssues] = useState<PublishIssue[]>(data.issues);
  const [locale, setLocale] = useState<Locale>(content.locales[0] ?? "nl-BE");
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [conflict, setConflict] = useState(false);
  const [scheduleAt, setScheduleAt] = useState("");
  const [redirectTo, setRedirectTo] = useState<Link | undefined>(undefined);
  const [retire, setRetire] = useState<"unpublish" | "archive" | null>(null);

  const update = (patch: Partial<Content>) => {
    setContent((c) => ({ ...c, ...patch }));
    setDirty(true);
  };
  const perLocale = useMemo(() => issuesByLocale(issues), [issues]);
  const issueBlockIds = useMemo(() => new Set(issues.filter((i) => i.locale === locale && i.blockId).map((i) => i.blockId!)), [issues, locale]);
  const archived = data.page.status === "archived";
  const draftRow = data.draft;
  const scheduled = draftRow?.scheduledPublishAt ?? null;
  const fail = (text: string) => setMessage({ kind: "error", text });

  const save = useCallback(async (): Promise<string | null> => {
    const payload = {
      pageId: data.page.pageId,
      ...(draftId ? { versionId: draftId, ...(updatedAt ? { expectedUpdatedAt: updatedAt } : {}) } : {}),
      title: content.title,
      paths: content.paths,
      blocks: content.blocks,
      seo: content.seo,
      excerpt: content.excerpt,
      coverMediaId: content.coverMediaId,
      locales: content.locales,
      isMaterialChange: content.isMaterialChange,
      changeSummary: content.changeSummary,
    };
    const res = await saveDraft(payload);
    if (!res.ok) {
      if (res.error.code === "conflict") setConflict(true);
      else fail(res.error.code === "validation" ? lbl(L, "issue.block_invalid") : res.error.message);
      return null;
    }
    setDraftId(res.data.versionId);
    setUpdatedAt(res.data.updatedAt);
    setIssues(res.data.issues);
    setDirty(false);
    setMessage({ kind: "ok", text: lbl(L, "editor.saved") });
    return res.data.versionId;
  }, [content, data.page.pageId, draftId, updatedAt, L]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (!archived) start(async () => void (await save()));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [save, archived]);

  const run = (fn: () => Promise<{ ok: boolean; error?: { code: string; message: string; fields?: Record<string, string> } }>, okText?: string) =>
    start(async () => {
      setMessage(null);
      const res = await fn();
      if (!res.ok) {
        const blocked = parseIssues(res.error?.fields);
        if (blocked.length) {
          setIssues(blocked);
          fail(lbl(L, "editor.issues"));
        } else fail(res.error?.message ?? "error");
        return;
      }
      if (okText) setMessage({ kind: "ok", text: okText });
      router.refresh();
    });

  const publishNow = () =>
    run(async () => {
      const id = dirty || !draftId ? await save() : draftId;
      if (!id) return { ok: false, error: { code: "validation", message: lbl(L, "editor.issues") } };
      return publishVersion({ versionId: id });
    }, lbl(L, "state.published"));

  const schedule = () =>
    run(async () => {
      const id = dirty || !draftId ? await save() : draftId;
      if (!id || !scheduleAt) return { ok: false, error: { code: "validation", message: lbl(L, "editor.scheduleAt") } };
      return publishVersion({ versionId: id, scheduleAt: new Date(scheduleAt).toISOString() });
    });

  const localeIssues = issues.filter((i) => !i.locale || i.locale === locale);
  const blocks = content.blocks[locale] ?? [];

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
      <div className="grid content-start gap-4">
        {data.outOfDate ? (
          <Alert>
            <AlertDescription className="flex flex-wrap items-center gap-2">
              {lbl(L, "editor.outOfDate")}
              <Button type="button" size="sm" variant="outline" onClick={() => setMessage(null)}>
                {lbl(L, "editor.keepDraft")}
              </Button>
              {draftId ? (
                <Button type="button" size="sm" variant="destructive" disabled={pending} onClick={() => run(() => discardDraft({ versionId: draftId }))}>
                  {lbl(L, "editor.discardDraft")}
                </Button>
              ) : null}
            </AlertDescription>
          </Alert>
        ) : null}
        {conflict ? (
          <Alert variant="destructive">
            <AlertDescription className="grid gap-2">
              <span>{lbl(L, "editor.conflict")}</span>
              <Button type="button" size="sm" variant="outline" className="justify-self-start" onClick={() => window.location.reload()}>
                {lbl(L, "editor.reload")}
              </Button>
              <details>
                <summary>{lbl(L, "editor.unsavedCopy")}</summary>
                <Textarea readOnly className="mt-2 font-mono text-xs" rows={8} value={JSON.stringify(content, null, 2)} aria-label={lbl(L, "editor.unsavedCopy")} />
              </details>
            </AlertDescription>
          </Alert>
        ) : null}
        {message ? (
          <p role="status" className={`text-sm ${message.kind === "error" ? "text-destructive" : "text-success"}`}>
            {message.text}
          </p>
        ) : null}

        <Tabs defaultValue="content">
          <TabsList>
            <TabsTrigger value="content">{lbl(L, "editor.tabContent")}</TabsTrigger>
            <TabsTrigger value="seo">{lbl(L, "editor.tabSeo")}</TabsTrigger>
            <TabsTrigger value="settings">{lbl(L, "editor.tabSettings")}</TabsTrigger>
            <TabsTrigger value="history">{lbl(L, "editor.tabHistory")}</TabsTrigger>
          </TabsList>

          <div className="mt-3 flex flex-wrap gap-1" role="tablist" aria-label={lbl(L, "newPage.locales")}>
            {content.locales.map((l) => (
              <Button key={l} type="button" role="tab" aria-selected={locale === l} size="sm" variant={locale === l ? "secondary" : "ghost"} onClick={() => setLocale(l)}>
                {l}
                {perLocale[l] ? <Badge variant="destructive">{perLocale[l]}</Badge> : <Badge variant="success">✓</Badge>}
              </Button>
            ))}
          </div>

          <TabsContent value="content" className="grid gap-4 pt-3">
            <TextField label={lbl(L, "pages.col.title")} value={content.title[locale] ?? ""} max={120} onChange={(v) => update({ title: { ...content.title, [locale]: v } })} />
            <TextField
              label={lbl(L, "editor.path")}
              hint={lbl(L, "editor.pathHelp")}
              prefix={`/${prefixFromLocale(locale)}/`}
              value={content.paths[locale] ?? ""}
              max={200}
              disabled={data.page.kind === "home"}
              onChange={(v) => update({ paths: { ...content.paths, [locale]: v.toLowerCase() } })}
            />
            {EXCERPT_KINDS.includes(data.page.kind) ? (
              <TextField label={lbl(L, "editor.excerpt")} multiline max={500} value={content.excerpt?.[locale] ?? ""} onChange={(v) => update({ excerpt: { ...(content.excerpt ?? {}), [locale]: v } })} />
            ) : null}
            <MediaPicker L={L} pickers={pickers} label={lbl(L, "editor.cover")} value={content.coverMediaId ?? undefined} onChange={(v) => update({ coverMediaId: v ?? null })} />
            <BlockListEditor
              locale={locale}
              blocks={blocks}
              sourceBlocks={content.blocks["nl-BE"]}
              onChange={(b) => update({ blocks: { ...content.blocks, [locale]: b } })}
              isLegal={data.page.kind === "legal"}
              L={L}
              pickers={pickers}
              rich={rich}
              issueBlockIds={issueBlockIds}
            />
          </TabsContent>

          <TabsContent value="seo" className="pt-3">
            <SeoFields L={L} pickers={pickers} value={content.seo[locale]} onChange={(s) => update({ seo: { ...content.seo, [locale]: s } })} />
          </TabsContent>

          <TabsContent value="settings" className="grid gap-4 pt-3">
            <fieldset className="grid gap-2">
              <legend className="text-sm font-medium">{lbl(L, "newPage.locales")}</legend>
              {LOCALES.map((l) => (
                <label key={l} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={content.locales.includes(l)}
                    onCheckedChange={(v) => {
                      const next = v === true ? LOCALES.filter((x) => x === l || content.locales.includes(x)) : content.locales.filter((x) => x !== l);
                      if (next.length) update({ locales: next });
                      if (!next.includes(locale) && next[0]) setLocale(next[0]);
                    }}
                  />
                  {l}
                </label>
              ))}
            </fieldset>
            {data.page.kind === "legal" ? (
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={content.isMaterialChange} onCheckedChange={(v) => update({ isMaterialChange: v === true })} />
                {lbl(L, "editor.materialChange")}
              </label>
            ) : null}
            <TextField label={lbl(L, "editor.changeSummary")} multiline max={500} value={content.changeSummary ?? ""} onChange={(v) => update({ changeSummary: v || null })} />
          </TabsContent>

          <TabsContent value="history" className="pt-3">
            <VersionHistory L={L} pageId={data.page.pageId} rows={data.history} hasDraft={!!draftId} locale={staffLocale} />
          </TabsContent>
        </Tabs>
      </div>

      <aside className="grid content-start gap-4">
        <div className="flex flex-wrap gap-2">
          <Badge variant={data.page.status === "published" ? "success" : "outline"}>{lbl(L, `status.${data.page.status}`)}</Badge>
          {data.live ? <Badge variant="secondary">{lbl(L, "state.liveVersion", { n: data.live.version })}</Badge> : null}
          {draftId ? <Badge variant="outline">{lbl(L, "state.hasDraft")}</Badge> : null}
        </div>
        {archived ? (
          canPublish ? (
            <Button type="button" disabled={pending} onClick={() => run(() => restoreArchivedPage({ pageId: data.page.pageId }))}>
              {lbl(L, "editor.restoreArchived")}
            </Button>
          ) : null
        ) : (
          <div className="grid gap-2">
            <Button type="button" disabled={pending} onClick={() => start(async () => void ((await save()) && router.refresh()))}>
              {lbl(L, "editor.save")}
            </Button>
            {draftId ? (
              <a className="text-center text-sm underline" href={`/${prefixFromLocale(locale)}/preview/${draftId}`} target="_blank" rel="noopener">
                {lbl(L, "editor.preview")}
              </a>
            ) : null}
            {draftId ? (
              <Button type="button" variant="ghost" disabled={pending} onClick={() => window.confirm(lbl(L, "editor.discardDraft")) && run(() => discardDraft({ versionId: draftId }))}>
                {lbl(L, "editor.discardDraft")}
              </Button>
            ) : null}
          </div>
        )}

        {canPublish && !archived ? (
          <section className="grid gap-2 rounded-md border p-3" aria-label={lbl(L, "editor.publishNow")}>
            <Button type="button" disabled={pending || (!draftId && !dirty)} onClick={publishNow}>
              {lbl(L, "editor.publishNow")}
            </Button>
            {scheduled ? (
              <div className="grid gap-1 text-sm">
                <span>{lbl(L, "state.scheduled", { date: new Intl.DateTimeFormat(staffLocale, { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Brussels" }).format(new Date(scheduled)) })}</span>
                <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => run(() => cancelScheduledPublish({ versionId: draftId! }))}>
                  {lbl(L, "editor.cancelSchedule")}
                </Button>
              </div>
            ) : (
              <div className="grid gap-1">
                <Label htmlFor="site-schedule-at">{lbl(L, "editor.scheduleAt")}</Label>
                <Input id="site-schedule-at" type="datetime-local" value={scheduleAt} onChange={(e) => setScheduleAt(e.target.value)} />
                <Button type="button" variant="outline" disabled={pending || !scheduleAt} onClick={schedule}>
                  {lbl(L, "editor.schedule")}
                </Button>
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              {data.page.status === "published" ? (
                <Button type="button" size="sm" variant="outline" onClick={() => setRetire("unpublish")}>
                  {lbl(L, "editor.unpublish")}
                </Button>
              ) : null}
              <Button type="button" size="sm" variant="outline" className="text-destructive" onClick={() => setRetire("archive")}>
                {lbl(L, "editor.archive")}
              </Button>
            </div>
            {retire ? (
              <div className="grid gap-2 rounded-md border p-2">
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox checked={!redirectTo} onCheckedChange={(v) => setRedirectTo(v === true ? undefined : { kind: "page", pageId: pickers.pages.find((p) => p.id !== data.page.pageId && p.status === "published")?.id ?? "" })} />
                  {lbl(L, "editor.noRedirect")}
                </label>
                {redirectTo ? <LinkPicker L={L} pickers={{ ...pickers, pages: pickers.pages.filter((p) => p.id !== data.page.pageId && p.status === "published") }} label={lbl(L, "editor.redirectTo")} value={redirectTo} onChange={setRedirectTo} /> : null}
                <div className="flex gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="destructive"
                    disabled={pending}
                    onClick={() => {
                      const input = { pageId: data.page.pageId, ...(redirectTo ? { redirectTo } : {}) };
                      run(() => (retire === "archive" ? archivePage(input) : unpublishPage(input)));
                      setRetire(null);
                    }}
                  >
                    {lbl(L, "common.confirm")}
                  </Button>
                  <Button type="button" size="sm" variant="ghost" onClick={() => setRetire(null)}>
                    {lbl(L, "common.cancel")}
                  </Button>
                </div>
              </div>
            ) : null}
          </section>
        ) : null}

        <section className="grid gap-2" aria-live="polite">
          <h2 className="text-sm font-semibold">{localeIssues.length ? lbl(L, "editor.issues") : lbl(L, "editor.noIssues")}</h2>
          <ul className="grid gap-1 text-sm">
            {localeIssues.map((i, k) => (
              <li key={k} className="text-destructive">
                {i.locale ? `${i.locale}: ` : ""}
                {L[`issue.${i.code}`] ?? i.message}
              </li>
            ))}
          </ul>
        </section>
        {claudePanel}
      </aside>
    </div>
  );
}

function TextField({ label, value, onChange, max, multiline, hint, prefix, disabled }: { label: string; value: string; onChange: (v: string) => void; max: number; multiline?: boolean; hint?: string; prefix?: string; disabled?: boolean }) {
  const id = `f-${label.replace(/\W+/g, "-").toLowerCase()}`;
  return (
    <div className="grid gap-1">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex items-center gap-1">
        {prefix ? <span className="text-sm text-muted-foreground">{prefix}</span> : null}
        {multiline ? (
          <Textarea id={id} value={value} maxLength={max} disabled={disabled} onChange={(e) => onChange(e.target.value)} />
        ) : (
          <Input id={id} value={value} maxLength={max} disabled={disabled} onChange={(e) => onChange(e.target.value)} />
        )}
      </div>
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// New page form (`/admin/site/pages/new`)
// ---------------------------------------------------------------------------------------------

/** Kind, slug, title per locale, locales, legal key (legal pages) and session (event pages). */
export function NewPageForm({ L, sessions }: { L: SiteAdminLabels; sessions: { id: string; label: string; hint?: string }[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [kind, setKind] = useState<PageKind>("standard");
  const [slug, setSlug] = useState("");
  const [title, setTitle] = useState<LocalizedText>({});
  const [locales, setLocales] = useState<Locale[]>([...LOCALES]);
  const [legalKey, setLegalKey] = useState<LegalKey>("terms");
  const [sessionId, setSessionId] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const submit = () =>
    start(async () => {
      setErrors({});
      setMessage(null);
      const res = await createPage({ kind, slug, title, locales, ...(kind === "legal" ? { legalKey } : {}), ...(kind === "event" && sessionId ? { sessionId } : {}) });
      if (res.ok) {
        router.push(`/admin/site/pages/${res.data.pageId}` as Route);
        return;
      }
      if (res.error.fields?.slug === "taken") setErrors({ slug: lbl(L, "newPage.slugTaken") });
      else if (res.error.fields) setErrors(res.error.fields);
      else setMessage(res.error.message);
    });
  return (
    <form
      className="grid max-w-2xl gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className="grid gap-1">
        <Label htmlFor="new-kind">{lbl(L, "newPage.kind")}</Label>
        <select id="new-kind" className={selectClass} value={kind} onChange={(e) => setKind(e.target.value as PageKind)}>
          {PAGE_KINDS.map((k) => (
            <option key={k} value={k}>
              {lbl(L, `kind.${k}`)}
            </option>
          ))}
        </select>
      </div>
      <div className="grid gap-1">
        <Label htmlFor="new-slug">{lbl(L, "newPage.slug")}</Label>
        <Input id="new-slug" value={slug} maxLength={80} aria-invalid={!!errors.slug} aria-describedby="new-slug-help" onChange={(e) => setSlug(e.target.value.toLowerCase())} />
        <p id="new-slug-help" className="text-xs text-muted-foreground">
          {lbl(L, "newPage.slugHelp")}
        </p>
        {errors.slug ? <p className="text-sm text-destructive">{errors.slug}</p> : null}
      </div>
      <fieldset className="grid gap-2">
        <legend className="text-sm font-medium">{lbl(L, "newPage.locales")}</legend>
        {LOCALES.map((l) => (
          <label key={l} className="flex items-center gap-2 text-sm">
            <Checkbox checked={locales.includes(l)} onCheckedChange={(v) => setLocales(v === true ? LOCALES.filter((x) => x === l || locales.includes(x)) : locales.filter((x) => x !== l))} />
            {l}
          </label>
        ))}
      </fieldset>
      <fieldset className="grid gap-2">
        <legend className="text-sm font-medium">{lbl(L, "newPage.titlePerLocale")}</legend>
        {locales.map((l) => (
          <div key={l} className="grid gap-1">
            <Label htmlFor={`new-title-${l}`}>{l}</Label>
            <Input id={`new-title-${l}`} value={title[l] ?? ""} maxLength={120} onChange={(e) => setTitle({ ...title, [l]: e.target.value })} />
          </div>
        ))}
      </fieldset>
      {kind === "legal" ? (
        <div className="grid gap-1">
          <Label htmlFor="new-legal">{lbl(L, "newPage.legalKey")}</Label>
          <select id="new-legal" className={selectClass} value={legalKey} onChange={(e) => setLegalKey(e.target.value as LegalKey)}>
            {LEGAL_KEYS.map((k) => (
              <option key={k} value={k}>
                {lbl(L, `legalKey.${k}`)}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      {kind === "event" ? <OptionSelect label={lbl(L, "newPage.session")} value={sessionId} onChange={setSessionId} options={sessions} /> : null}
      {message ? (
        <p role="status" className="text-sm text-destructive">
          {message}
        </p>
      ) : null}
      <Button type="submit" disabled={pending || !slug || !locales.length} className="justify-self-start">
        {lbl(L, "newPage.create")}
      </Button>
    </form>
  );
}
