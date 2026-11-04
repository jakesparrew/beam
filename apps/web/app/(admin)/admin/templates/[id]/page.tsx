import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Badge, Button } from "@beam/ui";
import { emptyDocument } from "@beam/core/email";
import { hasPermission, requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { archiveTemplate } from "@/modules/email/actions";
import { catalogueSection, getTemplate, staffEmailOf } from "@/modules/email/queries";
import { BlockEditor } from "@/modules/email/ui/editor/BlockEditor";
import { CopySlotsEditor } from "@/modules/email/ui/editor/CopySlotsEditor";
import { VersionHistory } from "@/modules/email/ui/editor/VersionHistory";


/** A text field of a submitted form (files and missing fields read as the fallback). */
function field(form: FormData, name: string, fallback = ""): string {
  const v = form.get(name);
  return typeof v === "string" ? v : fallback;
}

async function archive(form: FormData) {
  "use server";
  const id = field(form, "templateId");
  const result = await archiveTemplate({ templateId: id });
  redirect(`/admin/templates?kind=marketing${result.ok ? "" : `&error=${encodeURIComponent(result.error.message)}`}` as never);
}

/**
 * `/admin/templates/[id]` (`email.write`; publish `email.send`), email spec section 5. Marketing
 * and block-backed transactional templates open the three-pane block editor; code-backed
 * transactional templates the copy slots editor with the live preview of the component. Version
 * history lists every version read-only.
 */
export default async function TemplatePage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requireStaff({ permission: "email.write" });
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const locale = await adminLocale();
  const tr = translator(locale);
  const t = (k: string) => tr(`email.templates.${k}`);
  const db = await getAppDb();
  const detail = await getTemplate(db, id);
  if (!detail || !detail.editing) notFound();
  const { template, editing, current, draft } = detail;
  const labels = catalogueSection(locale, "email.editor");
  const localeNames = { "nl-BE": tr("email.editor.locale_nl"), "fr-BE": tr("email.editor.locale_fr"), en: tr("email.editor.locale_en") };
  const canPublish = hasPermission(actor, "email.send");
  const canReadPersons = hasPermission(actor, "persons.read");
  const defaultTo = await staffEmailOf(db, actor.userId);
  const dateFmt = new Intl.DateTimeFormat(locale, { timeZone: "Europe/Brussels", dateStyle: "medium", timeStyle: "short" });
  const common = {
    templateId: template.id,
    canPublish: canPublish && template.status !== "archived",
    canReadPersons,
    localeNames,
    defaultTo,
    labels,
  };
  const initialBase = {
    subject: editing.subject,
    preheader: editing.preheader,
    draftUpdatedAt: (detail.draftUpdatedAt ?? editing.updatedAt).toISOString(),
    completeness: detail.completeness,
    hasDraft: !!draft,
    hasCurrent: !!current,
  };

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid gap-1">
          <h1 className="text-2xl font-semibold">{template.name}</h1>
          <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <span className="font-mono">{template.slug}</span>
            <Badge variant="outline">{t(`tab_${template.kind}`)}</Badge>
            <Badge variant={template.status === "published" ? "default" : "secondary"}>{t(`status_${template.status}`)}</Badge>
            {template.purpose ? <Badge variant="outline">{t(`purpose_${template.purpose}`)}</Badge> : null}
            {template.isSystem ? <Badge variant="outline">{t("system")}</Badge> : null}
            {current ? <span>{`v${current.version}`}</span> : null}
          </div>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" asChild>
            <Link href={`/admin/templates/${template.id}/preview`}>{tr("email.editor.open_preview")}</Link>
          </Button>
          {canPublish && !template.isSystem && template.status !== "archived" ? (
            <form action={archive}>
              <input type="hidden" name="templateId" value={template.id} />
              <Button type="submit" variant="ghost">
                {t("archive")}
              </Button>
            </form>
          ) : null}
        </div>
      </div>
      {detail.references.campaigns.length || detail.references.automations ? (
        <p className="text-sm text-muted-foreground">
          {t("used_by")}{" "}
          {[...detail.references.campaigns.map((c) => c.name), ...(detail.references.automations ? [t("used_by_automation")] : [])].join(", ")}
        </p>
      ) : null}
      {editing.reactComponent ? (
        <CopySlotsEditor {...common} initial={{ ...initialBase, copy: editing.copy ?? {} }} slots={detail.slots} slotDefaults={detail.slotDefaults} />
      ) : (
        <BlockEditor {...common} initial={{ ...initialBase, document: editing.document ?? emptyDocument() }} mergeFields={detail.mergeFields} />
      )}
      <VersionHistory
        templateId={template.id}
        currentVersionId={template.currentVersionId}
        labels={labels}
        versions={detail.versions.map((v) => ({ id: v.id, version: v.version, publishedAt: v.publishedAt ? dateFmt.format(v.publishedAt) : null, createdAt: dateFmt.format(v.createdAt) }))}
      />
    </div>
  );
}
