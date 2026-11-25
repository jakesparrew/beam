import Link from "next/link";
import { notFound } from "next/navigation";
import { Alert, AlertDescription } from "@beam/ui";
import { requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, softTranslator, translator } from "@/lib/i18n";
import { catalogueSection, DANGEROUS_PERMISSIONS, getRole, roleLabel } from "@/modules/platform/queries";
import { CustomRoleDetails, RoleEditor } from "@/modules/platform/ui/role-editor";

/**
 * `/admin/settings/roles/[key]` (`users.manage`): the permission checklist grouped by module, one
 * plain sentence per permission (`<module>.permissions.<permission with _>`) and a mark on the
 * dangerous ones; rename and delete for a custom role. A permission the actor does not hold is
 * granted only by an Administrator; the Administrator role is read-only. Unknown permissions
 * are listed (PL-18).
 */
export default async function RolePage({ params }: { params: Promise<{ key: string }> }) {
  const actor = await requireStaff({ permission: "users.manage" });
  const { key } = await params;
  const locale = await adminLocale();
  const tr = translator(locale);
  const soft = softTranslator(locale);
  const t = (k: string, p?: Record<string, string | number>) => tr(`platform.role_editor.${k}`, p);
  const role = await getRole(await getAppDb(), key);
  if (!role) notFound();
  const label = roleLabel({ key: role.key, name: role.name, isSystem: role.isSystem }, locale);
  const describe = (module: string, permission: string) => {
    const k = `${module}.permissions.${permission.replace(/\./g, "_")}`;
    const text = soft(k);
    return text === k ? "" : text;
  };
  const moduleLabel = (module: string) => {
    const k = `platform.role_editor.module_${module}`;
    return soft(k) === k ? module : soft(k);
  };
  const groups = role.groups
    .map((g) => ({
      module: g.module,
      label: moduleLabel(g.module),
      permissions: g.permissions.map((p) => ({ key: p, description: describe(g.module, p), dangerous: DANGEROUS_PERMISSIONS.has(p) })),
    }))
    .sort((a, b) => a.label.localeCompare(b.label, locale));
  const labels = catalogueSection(locale, "platform.role_editor");
  const errors = catalogueSection(locale, "platform.errors");
  const description = (role.description as Record<string, string>)[locale] ?? "";

  return (
    <div className="grid gap-6">
      <header className="grid gap-2">
        <Link href="/admin/settings/roles" className="text-sm text-muted-foreground hover:underline">
          {t("back")}
        </Link>
        <h1 className="text-2xl font-semibold">{label}</h1>
        {description ? <p>{description}</p> : null}
        <p className="text-muted-foreground">{role.isOwner ? t("owner_read_only") : t("edit_intro")}</p>
      </header>
      {role.unknownPermissions.length ? (
        <Alert role="status">
          <AlertDescription>
            {t("unknown_on_role")} <span className="font-mono text-xs">{role.unknownPermissions.join(", ")}</span>
          </AlertDescription>
        </Alert>
      ) : null}
      {role.isSystem ? null : <CustomRoleDetails role={{ key: role.key, name: label, description, holders: role.holders }} labels={labels} errors={errors} />}
      <RoleEditor
        roleKey={role.key}
        granted={role.isOwner ? groups.flatMap((g) => g.permissions.map((p) => p.key)) : role.permissions.filter((p) => !role.unknownPermissions.includes(p))}
        groups={groups}
        actorPermissions={[...actor.permissions]}
        actorIsOwner={actor.roleKey === "owner"}
        readOnly={role.isOwner}
        labels={labels}
        errors={errors}
      />
    </div>
  );
}
