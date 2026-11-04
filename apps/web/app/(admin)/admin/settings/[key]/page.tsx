import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, softTranslator, translator } from "@/lib/i18n";
import { catalogueSection, getSettingForEdit } from "@/modules/platform/queries";
import { SettingsForm } from "@/modules/platform/ui/settings-form";
import { zodToFormFields } from "@/modules/platform/ui/zod-form";

/** Keys with their own screen or written only by the system. */
const DEDICATED: Record<string, "/admin/settings/ai" | "/admin/system/go-live" | "/admin/system/security"> = {
  ai: "/admin/settings/ai",
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
  const titleKey = `${setting.owner}.settings.${key}`;
  const title = soft(titleKey) === titleKey ? key.replace(/_/g, " ") : soft(titleKey);

  return (
    <div className="grid gap-6">
      <header className="grid gap-2">
        <Link href="/admin/settings" className="text-sm text-muted-foreground hover:underline">
          {tr("platform.settings.back")}
        </Link>
        <h1 className="text-2xl font-semibold">{title}</h1>
        {setting.description ? <p className="text-muted-foreground">{setting.description}</p> : null}
        <p className="text-sm text-muted-foreground">
          {tr("platform.settings.version", { version: setting.version })}
          {" · "}
          {setting.updatedAt
            ? tr("platform.settings.last_edit", { who: setting.updatedBy ?? "–", when: setting.updatedAt.toLocaleString(locale, { timeZone: "Europe/Brussels" }) })
            : tr("platform.settings.default_value")}
        </p>
      </header>
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
