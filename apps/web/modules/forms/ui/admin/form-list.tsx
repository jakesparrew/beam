"use client";

/**
 * Back-office form screens' client parts (forms spec section 5; forms-P5): the form list
 * (DataTable with status and kind filters and search), the "new form" form, the overview's status
 * actions (edit draft, archive, unarchive, delete, duplicate; P12 and P13 guards are enforced by
 * the actions) and "Restore as draft" on the versions page. Errors show a toast with the code's
 * message.
 */
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FORM_KINDS, type FormKind } from "@beam/core/forms";
import { LOCALES, type Locale, type LocalizedText } from "@beam/core/i18n";
import { Badge, Button, DataTable, EmptyState, Input, LocalizedInput, toast, type DataTableColumn } from "@beam/ui";
import { archiveForm, createDraft, createForm, deleteForm, duplicateForm, unarchiveForm } from "../../actions";
import type { FormListRow } from "../../queries";
import { selectClass } from "./condition-builder";
import { textLabels } from "./field-editor";
import { lbl, type Labels } from "./issues-panel";

const pct = (v: number | null) => (v === null ? "–" : `${Math.round(v * 100)}%`);

export type FormListProps = {
  rows: FormListRow[];
  labels: Labels;
  locale: Locale;
  searchParams: Record<string, string | undefined>;
  filtered: boolean;
};

export function FormList({ rows, labels, locale, searchParams, filtered }: FormListProps) {
  const columns: DataTableColumn<FormListRow>[] = [
    { key: "name", header: lbl(labels, "list.name"), cell: (r) => r.name[locale] || r.slug },
    { key: "slug", header: lbl(labels, "list.slug"), cell: (r) => <code className="text-xs">{r.slug}</code> },
    { key: "kind", header: lbl(labels, "list.kind"), cell: (r) => lbl(labels, `kind.${r.kind}`) },
    {
      key: "status",
      header: lbl(labels, "list.status"),
      cell: (r) => (
        <span className="flex items-center gap-1">
          <Badge variant={r.status === "published" ? "success" : r.status === "archived" ? "secondary" : "outline"}>{lbl(labels, `status.${r.status}`)}</Badge>
          {r.hasDraft && r.status !== "draft" ? <Badge variant="warning">{lbl(labels, "list.draft_badge")}</Badge> : null}
        </span>
      ),
    },
    { key: "version", header: lbl(labels, "list.version"), cell: (r) => (r.currentVersion ? `v${r.currentVersion}` : "–"), align: "right" },
    { key: "locales", header: lbl(labels, "list.locales"), cell: (r) => r.locales.join(", ") },
    { key: "started", header: lbl(labels, "list.started"), cell: (r) => r.started30d, align: "right" },
    { key: "completed", header: lbl(labels, "list.completed"), cell: (r) => r.completed30d, align: "right" },
    { key: "rate", header: lbl(labels, "list.rate"), cell: (r) => pct(r.completionRate), align: "right" },
  ];
  return (
    <DataTable
      columns={columns}
      rows={rows}
      rowKey={(r) => r.id}
      onRowHref={(r) => `/admin/forms/${r.id}`}
      searchParams={searchParams}
      caption={lbl(labels, "list.title")}
      filters={[
        { kind: "search", key: "q", label: lbl(labels, "list.search"), placeholder: lbl(labels, "list.search_placeholder") },
        { kind: "select", key: "status", label: lbl(labels, "list.status"), allLabel: lbl(labels, "list.all_statuses"), options: (["draft", "published", "archived"] as const).map((s) => ({ value: s, label: lbl(labels, `status.${s}`) })) },
        { kind: "select", key: "kind", label: lbl(labels, "list.kind"), allLabel: lbl(labels, "list.all_kinds"), options: FORM_KINDS.map((k) => ({ value: k, label: lbl(labels, `kind.${k}`) })) },
      ]}
      labels={{ pagination: lbl(labels, "list.pagination"), previous: lbl(labels, "list.previous"), next: lbl(labels, "list.next"), applyFilters: lbl(labels, "list.apply"), filters: lbl(labels, "list.filters") }}
      emptyState={
        filtered ? (
          <EmptyState title={lbl(labels, "list.no_match")} />
        ) : (
          <EmptyState
            title={lbl(labels, "list.empty")}
            action={
              <div className="flex gap-2">
                <Link className="underline" href="/admin/forms/new?template=lead&kind=lead">
                  {lbl(labels, "list.template_lead")}
                </Link>
                <Link className="underline" href="/admin/forms/new?template=assessment&kind=assessment">
                  {lbl(labels, "list.template_assessment")}
                </Link>
              </div>
            }
          />
        )
      }
    />
  );
}

export type NewFormProps = { labels: Labels; localeNames: Record<Locale, string>; initialKind?: FormKind; initialTemplate?: "blank" | "lead" | "assessment" };

export function NewFormForm({ labels, localeNames, initialKind = "lead", initialTemplate = "blank" }: NewFormProps) {
  const router = useRouter();
  const [slug, setSlug] = useState("");
  const [kind, setKind] = useState<FormKind>(initialKind);
  const [name, setName] = useState<LocalizedText>({});
  const [locales, setLocales] = useState<Locale[]>(["nl-BE", "fr-BE", "en"]);
  const [template, setTemplate] = useState(initialTemplate);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const tl = textLabels(labels, localeNames);
  const fieldError = (k: string) => (fields[k] ? lbl(labels, `new.error_${fields[k]}`) : null);
  return (
    <form
      className="grid max-w-2xl gap-4"
      onSubmit={(e) => {
 void (async () => {
        e.preventDefault();
        setBusy(true);
        const r = await createForm({ slug, kind, name, locales, template });
        setBusy(false);
        if (r.ok) router.push(`/admin/forms/${r.data.formId}/build` as never);
        else if (r.error.code === "validation") setFields(Object.fromEntries(Object.entries(r.error.fields ?? {}).map(([k, v]) => [k.split(".")[0]!, v.replace(/\W+/g, "_").toLowerCase()])));
        else toast.error(lbl(labels, `builder.error.${r.error.code}`));
      })();
}}
    >
      <label className="grid gap-1 text-sm">
        {lbl(labels, "new.slug")}
        <Input value={slug} onChange={(e) => setSlug(e.target.value.toLowerCase())} required maxLength={64} aria-invalid={fields.slug ? true : undefined} aria-describedby="slug-help" className="font-mono" />
        <span id="slug-help" className={`text-xs ${fields.slug ? "text-destructive" : "text-muted-foreground"}`}>
          {fieldError("slug") ?? lbl(labels, "new.slug_help")}
        </span>
      </label>
      <label className="grid gap-1 text-sm">
        {lbl(labels, "new.kind")}
        <select className={selectClass} value={kind} onChange={(e) => setKind(e.target.value as FormKind)}>
          {FORM_KINDS.map((k) => (
            <option key={k} value={k}>
              {lbl(labels, `kind.${k}`)}
            </option>
          ))}
        </select>
      </label>
      <LocalizedInput name="name" value={name} onChange={(v) => setName(v)} locales={locales} labels={tl("new.name")} error={fieldError("name")} />
      <fieldset className="grid gap-2">
        <legend className="text-sm font-medium">{lbl(labels, "new.locales")}</legend>
        {LOCALES.map((l) => (
          <label key={l} className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={locales.includes(l)} onChange={(e) => setLocales(e.target.checked ? LOCALES.filter((x) => x === l || locales.includes(x)) : locales.filter((x) => x !== l))} />
            {localeNames[l]}
          </label>
        ))}
      </fieldset>
      <label className="grid gap-1 text-sm">
        {lbl(labels, "new.template")}
        <select className={selectClass} value={template} onChange={(e) => setTemplate(e.target.value as typeof template)}>
          {(["blank", "lead", "assessment"] as const).map((t) => (
            <option key={t} value={t}>
              {lbl(labels, `new.template_${t}`)}
            </option>
          ))}
        </select>
      </label>
      <div>
        <Button type="submit" disabled={busy || !slug || !locales.length}>
          {lbl(labels, "new.create")}
        </Button>
      </div>
    </form>
  );
}

export type FormActionsProps = {
  formId: string;
  slug: string;
  status: "draft" | "published" | "archived";
  isSystem: boolean;
  everPublished: boolean;
  hasDraft: boolean;
  currentVersion: number | null;
  canPublish: boolean;
  labels: Labels;
  name: LocalizedText;
};

/** Overview buttons: edit or create the draft, archive, unarchive, delete, duplicate. */
export function FormActions(p: FormActionsProps) {
  const router = useRouter();
  const [dupSlug, setDupSlug] = useState("");
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<{ ok: boolean; error?: { code: string; message: string } }>, after?: () => void) => {
    setBusy(true);
    const r = await fn();
    setBusy(false);
    if (r.ok) {
      after?.();
      router.refresh();
    } else toast.error(lbl(labels, r.error?.message && labels[`overview.error.${r.error.message}`] ? `overview.error.${r.error.message}` : `builder.error.${r.error?.code ?? "internal"}`));
  };
  const labels = p.labels;
  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap gap-2">
        {p.hasDraft ? (
          <Link className="inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm text-primary-foreground" href={`/admin/forms/${p.formId}/build`}>
            {lbl(labels, "overview.edit_draft")}
          </Link>
        ) : (
          <Button type="button" disabled={busy} onClick={() => void run(() => createDraft({ formId: p.formId }), () => router.push(`/admin/forms/${p.formId}/build` as never))}>
            {lbl(labels, "overview.create_draft", { n: p.currentVersion ?? 1 })}
          </Button>
        )}
        {p.canPublish && p.status === "published" && !p.isSystem ? (
          <Button type="button" variant="outline" disabled={busy} onClick={() => void (window.confirm(lbl(labels, "overview.archive_confirm")) && run(() => archiveForm({ formId: p.formId })))}>
            {lbl(labels, "overview.archive")}
          </Button>
        ) : null}
        {p.canPublish && p.status === "archived" ? (
          <Button type="button" variant="outline" disabled={busy} onClick={() => void run(() => unarchiveForm({ formId: p.formId }))}>
            {lbl(labels, "overview.unarchive")}
          </Button>
        ) : null}
        {p.canPublish && !p.everPublished && !p.isSystem ? (
          <Button type="button" variant="destructive" disabled={busy} onClick={() => void (window.confirm(lbl(labels, "overview.delete_confirm")) && run(() => deleteForm({ formId: p.formId }), () => router.push("/admin/forms")))}>
            {lbl(labels, "overview.delete")}
          </Button>
        ) : null}
      </div>
      {p.isSystem ? <p className="text-sm text-muted-foreground">{lbl(labels, "overview.system_form")}</p> : null}
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void run(
            () => duplicateForm({ formId: p.formId, newSlug: dupSlug, name: p.name }),
            () => setDupSlug(""),
          );
        }}
      >
        <label className="grid gap-1 text-sm">
          {lbl(labels, "overview.duplicate_slug")}
          <Input className="w-56 font-mono" value={dupSlug} onChange={(e) => setDupSlug(e.target.value.toLowerCase())} />
        </label>
        <Button type="submit" variant="outline" disabled={busy || !dupSlug}>
          {lbl(labels, "overview.duplicate")}
        </Button>
      </form>
    </div>
  );
}

/** "Restore as draft" of one version (P9); refused with conflict while a draft exists. */
export function RestoreButton({ formId, versionId, labels }: { formId: string; versionId: string; labels: Labels }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={busy}
      onClick={() => {
 void (async () => {
        setBusy(true);
        const r = await createDraft({ formId, fromVersionId: versionId });
        setBusy(false);
        if (r.ok) router.push(`/admin/forms/${formId}/build` as never);
        else toast.error(lbl(labels, r.error.code === "conflict" ? "versions.draft_exists" : `builder.error.${r.error.code}`));
      })();
}}
    >
      {lbl(labels, "versions.restore")}
    </Button>
  );
}

/** Copies a text (hosted URL, embed snippet) to the clipboard. */
export function CopyButton({ text, labels }: { text: string; labels: Labels }) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={() => {
 void (async () => {
        try {
          await navigator.clipboard.writeText(text);
          toast.success(lbl(labels, "links.copied"));
        } catch {
          toast.error(lbl(labels, "links.copy_failed"));
        }
      })();
}}
    >
      {lbl(labels, "links.copy")}
    </Button>
  );
}
