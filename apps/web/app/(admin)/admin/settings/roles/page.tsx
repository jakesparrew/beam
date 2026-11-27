import Link from "next/link";
import { cn } from "@beam/ui";
import { requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { catalogueSection, listRoles } from "@/modules/platform/queries";
import { PageHeader, StatusPill, Surface, td, th } from "@/modules/platform/ui/admin-kit";
import { Notice, rowClass, rowLink } from "@/modules/platform/ui/admin-list-kit";
import { CreateRoleForm } from "@/modules/platform/ui/role-editor";
import { PERMISSIONS } from "@/registry/permissions.generated";

/**
 * `/admin/settings/roles` (`users.manage`): the predefined roles (Administrator, Manager, Front
 * Desk, Finance / Accounts, partner) and the custom roles with member and permission counts, the
 * form for a new custom role, and the permission strings a role still holds that the registry
 * no longer declares (PL-18).
 */
export default async function RolesPage() {
  await requireStaff({ permission: "users.manage" });
  const locale = await adminLocale();
  const tr = translator(locale);
  const t = (k: string, p?: Record<string, string | number>) => tr(`platform.role_editor.${k}`, p);
  const roles = await listRoles(await getAppDb(), locale);
  const withUnknown = roles.filter((r) => r.unknownPermissions.length > 0);

  return (
    <div className="grid gap-4">
      <PageHeader title={t("title")} description={t("intro")} />
      {withUnknown.length ? (
        <Notice tone="warn" role="status">
          {t("unknown_warning")}{" "}
          {withUnknown.map((r) => (
            <span key={r.key} className="mr-2">
              {r.label}: <span className="font-mono text-[0.75rem]">{r.unknownPermissions.join(", ")}</span>
            </span>
          ))}
        </Notice>
      ) : null}
      <Surface flush>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[40rem] text-[0.8125rem]">
            <caption className="sr-only">{t("title")}</caption>
            <thead className="bg-[#faf9f6]">
              <tr className="border-b border-border">
                <th scope="col" className={th}>{t("col_role")}</th>
                <th scope="col" className={cn(th, "w-36")}>{t("col_kind")}</th>
                <th scope="col" className={cn(th, "w-28 text-right")}>{t("col_members")}</th>
                <th scope="col" className={cn(th, "w-56 text-right")}>{t("col_permissions")}</th>
              </tr>
            </thead>
            <tbody>
              {roles.map((r) => (
                <tr key={r.key} className={rowClass}>
                  <td className={td}>
                    <Link href={`/admin/settings/roles/${r.key}`} className={cn(rowLink, "font-semibold hover:underline")}>
                      {r.label}
                    </Link>
                  </td>
                  <td className={td}>{r.isSystem ? <StatusPill tone="muted">{t("kind_predefined")}</StatusPill> : <StatusPill tone="info">{t("kind_custom")}</StatusPill>}</td>
                  <td className={cn(td, "text-right font-semibold tabular-nums")}>{r.members}</td>
                  <td className={cn(td, "text-right tabular-nums text-muted-foreground")}>{r.permissions.includes("*") ? t("all_permissions") : t("permission_count", { count: r.permissions.length - r.unknownPermissions.length, total: PERMISSIONS.length })}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Surface>
      <CreateRoleForm labels={catalogueSection(locale, "platform.role_editor")} errors={catalogueSection(locale, "platform.errors")} />
    </div>
  );
}
