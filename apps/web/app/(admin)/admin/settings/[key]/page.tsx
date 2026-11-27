import { notFound, redirect } from "next/navigation";
import { requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, softTranslator, translator } from "@/lib/i18n";
import { catalogueSection, getSettingForEdit } from "@/modules/platform/queries";
import { PageHeader } from "@/modules/platform/ui/admin-kit";
import { BackLink } from "@/modules/platform/ui/admin-list-kit";
import { SettingsForm } from "@/modules/platform/ui/settings-form";
import { zodToFormFields } from "@/modules/platform/ui/zod-form";

/** Keys with their own screen or written only by the system. */
const DEDICATED: Record<string, "/admin/settings/ai" | "/admin/system/go-live" | "/admin/system/security" | "/admin/sessions/rules" | "/admin/sessions/rules?tab=hours"> = {
  ai: "/admin/settings/ai",
  booking_rules: "/admin/sessions/rules",
  business_hours: "/admin/sessions/rules?tab=hours",
  go_live_gate: "/admin/system/go-live",
  security: "/admin/system/security",
};
const SYSTEM_ONLY = new Set(["last_tick_at", "automation_cursor"]);

/**
 * `/admin/settings/[key]` (`settings.write`): the generic editor of any declared settings key, a
 * form generated from the key's Zod schema with a JSON editor for deeper values; shows the version
 * and the last editor. The action re-validates with the schema and the expected version (PL-41).
 */
export default async function SettingKeyPage({ params }: { params: Promise<{ key: string }> }) {
  await requireStaff({ permission: "settings.write" });
  const { key } = await params;
  const dedicated = DEDICATED[key];
  if (dedicated) redirect(dedicated);
  if (SYSTEM_ONLY.has(key)) notFound();
  const locale = await adminLocale();
  const tr = translator(locale);
  const soft = softTranslator(locale);
  const setting = await getSettingForEdit(await getAppDb(), key);
  if (!setting) notFound();
  const titleKey = `platform.settings.overview.title.${key}`;
  const title = soft(titleKey) === titleKey ? key.replace(/_/g, " ") : soft(titleKey);
  const descKey = `platform.settings.overview.desc.${key}`;
  const description = soft(descKey) === descKey ? setting.description : soft(descKey);

  return (
    <div className="grid max-w-4xl gap-4">
      <BackLink href="/admin/settings">{tr("platform.settings.title")}</BackLink>
      <PageHeader
        title={<span className="inline-block first-letter:uppercase">{title}</span>}
        description={
          <>
            {description ? <span className="block">{description}</span> : null}
            <span className="block text-[0.75rem]">
              {tr("platform.settings.version", { version: setting.version })}
              {" · "}
              {setting.updatedAt
                ? tr("platform.settings.last_edit", { who: setting.updatedBy ?? "–", when: setting.updatedAt.toLocaleString(locale, { timeZone: "Europe/Brussels" }) })
                : tr("platform.settings.default_value")}
            </span>
          </>
        }
      />
      <SettingsForm
        settingKey={key}
        version={setting.version}
        value={setting.value}
        fields={zodToFormFields(setting.schema)}
        labels={catalogueSection(locale, "platform.settings")}
        errors={catalogueSection(locale, "platform.errors")}
      />
    </div>
  );
}
