import Link from "next/link";
import { Alert, AlertDescription, Badge, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@beam/ui";
import { requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { catalogueSection, listRoles } from "@/modules/platform/queries";
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
    <div className="grid gap-6">
      <header className="grid gap-2">
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <p className="text-muted-foreground">{t("intro")}</p>
      </header>
      {withUnknown.length ? (
        <Alert role="status">
          <AlertDescription>
            {t("unknown_warning")}
            <ul className="mt-2 list-disc pl-5">
              {withUnknown.map((r) => (
                <li key={r.key}>
                  {r.label}: <span className="font-mono text-xs">{r.unknownPermissions.join(", ")}</span>
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("col_role")}</TableHead>
            <TableHead>{t("col_kind")}</TableHead>
            <TableHead>{t("col_members")}</TableHead>
            <TableHead>{t("col_permissions")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {roles.map((r) => (
            <TableRow key={r.key}>
              <TableCell>
                <Link href={`/admin/settings/roles/${r.key}`} className="font-medium hover:underline">
                  {r.label}
                </Link>
              </TableCell>
              <TableCell>{r.isSystem ? <Badge variant="secondary">{t("kind_predefined")}</Badge> : <Badge variant="outline">{t("kind_custom")}</Badge>}</TableCell>
              <TableCell>{r.members}</TableCell>
              <TableCell>{r.permissions.includes("*") ? t("all_permissions") : t("permission_count", { count: r.permissions.length - r.unknownPermissions.length, total: PERMISSIONS.length })}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <CreateRoleForm labels={catalogueSection(locale, "platform.role_editor")} errors={catalogueSection(locale, "platform.errors")} />
    </div>
  );
}
