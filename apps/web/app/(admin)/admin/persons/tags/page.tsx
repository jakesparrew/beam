import { hasPermission, requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { listTags } from "@/modules/crm/queries";
import { TagsManager } from "@/modules/crm/ui/tag-picker";
import { localeOptions } from "@/modules/crm/ui/status-badge";

/** `/admin/persons/tags` (`persons.read`; edit `persons.write`), crm spec 5.1. */
export default async function TagsPage() {
  const actor = await requireStaff({ permission: "persons.read" });
  const locale = await adminLocale();
  const tr = translator(locale);
  const db = await getAppDb();
  const tags = await listTags(db);
  const t = (k: string) => tr(`crm.tags.${k}`);
  return (
    <div className="grid gap-6">
      <h1 className="text-2xl font-semibold">{t("title")}</h1>
      <TagsManager
        tags={tags}
        canEdit={hasPermission(actor, "persons.write")}
        locale={locale}
        labels={{
          title: t("title"),
          empty: t("empty"),
          colKey: t("col_key"),
          colName: t("col_name"),
          colColor: t("col_color"),
          colCount: t("col_count"),
          colSystem: t("col_system"),
          actions: tr("crm.common.actions"),
          create: t("create"),
          rename: t("rename"),
          recolour: t("recolour"),
          delete: t("delete"),
          description: t("description"),
          systemLocked: t("system_locked"),
          keyHint: t("key_hint"),
          save: tr("crm.common.save"),
          cancel: tr("crm.common.cancel"),
          yes: tr("crm.common.yes"),
          no: tr("crm.common.no"),
          missingLocales: tr("crm.common.missing_locales", { locales: localeOptions(tr).map((o) => o.label).join(", ") }),
          keyTaken: tr("crm.common.error"),
          error: tr("crm.common.error"),
          pagination: tr("crm.common.page_of", { page: 1, pages: 1 }),
          previous: tr("crm.common.previous"),
          next: tr("crm.common.next"),
          localized: {
            field: t("col_name"),
            locales: Object.fromEntries(localeOptions(tr).map((o) => [o.value, o.label])),
            missing: tr("crm.common.required"),
            complete: tr("crm.common.yes"),
          },
        }}
      />
    </div>
  );
}
