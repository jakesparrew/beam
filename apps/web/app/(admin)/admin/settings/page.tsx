import Link from "next/link";
import { notFound } from "next/navigation";
import { Card, CardDescription, CardHeader, CardTitle } from "@beam/ui";
import { hasPermission, requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, softTranslator, translator } from "@/lib/i18n";
import { listSettings } from "@/modules/platform/queries";

/** Keys with their own screen (or written by the system) that get no generic card. */
const OWN_SCREEN = new Set(["ai", "company", "go_live_gate", "security", "last_tick_at", "automation_cursor"]);

/**
 * `/admin/settings` (`settings.write` or `users.manage` or `flags.manage`): index cards for Users,
 * Roles, Flags, AI and Company, then one card per declared module settings key.
 */
export default async function SettingsIndexPage() {
  const actor = await requireStaff();
  const canSettings = hasPermission(actor, "settings.write");
  const canUsers = hasPermission(actor, "users.manage");
  const canFlags = hasPermission(actor, "flags.manage");
  if (!canSettings && !canUsers && !canFlags) notFound();
  const locale = await adminLocale();
  const tr = translator(locale);
  const soft = softTranslator(locale);
  const t = (k: string) => tr(`platform.settings.${k}`);
  const keys = canSettings ? (await listSettings(await getAppDb())).filter((s) => !s.isSystem && !OWN_SCREEN.has(s.key)) : [];

  const cards: { key: string; href: string; title: string; description: string }[] = [
    ...(canUsers
      ? [
          { key: "users", href: "/admin/settings/users", title: t("card_users"), description: t("card_users_description") },
          { key: "roles", href: "/admin/settings/roles", title: t("card_roles"), description: t("card_roles_description") },
        ]
      : []),
    ...(canFlags ? [{ key: "flags", href: "/admin/settings/flags", title: t("card_flags"), description: t("card_flags_description") }] : []),
    ...(canSettings
      ? [
          { key: "ai", href: "/admin/settings/ai", title: t("card_ai"), description: t("card_ai_description") },
          { key: "company", href: "/admin/settings/company", title: t("card_company"), description: t("card_company_description") },
        ]
      : []),
  ];

  const keyTitle = (key: string, owner: string) => {
    const label = soft(`${owner}.settings.${key}`);
    return label === `${owner}.settings.${key}` ? key.replace(/_/g, " ") : label;
  };

  return (
    <div className="grid gap-6">
      <header className="grid gap-2">
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <p className="text-muted-foreground">{t("intro")}</p>
      </header>
      <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {cards.map((c) => (
          <li key={c.key}>
            <Card className="h-full">
              <CardHeader>
                <CardTitle className="text-base">
                  <Link href={c.href as never} className="hover:underline">
                    {c.title}
                  </Link>
                </CardTitle>
                <CardDescription>{c.description}</CardDescription>
              </CardHeader>
            </Card>
          </li>
        ))}
      </ul>
      {keys.length ? (
        <section className="grid gap-3" aria-labelledby="module-settings">
          <h2 id="module-settings" className="text-lg font-medium">
            {t("module_settings")}
          </h2>
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {keys.map((s) => (
              <li key={s.key}>
                <Card className="h-full">
                  <CardHeader>
                    <CardTitle className="text-base">
                      <Link href={`/admin/settings/${s.key}`} className="hover:underline">
                        {keyTitle(s.key, s.owner)}
                      </Link>
                    </CardTitle>
                    <CardDescription>
                      {s.description || t("no_description")} · {tr("platform.settings.owner_module", { module: s.owner })}
                    </CardDescription>
                  </CardHeader>
                </Card>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
