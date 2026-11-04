import Link from "next/link";
import { notFound } from "next/navigation";
import { Alert, AlertDescription } from "@beam/ui";
import { requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, softTranslator, translator } from "@/lib/i18n";
import { catalogueSection, getRole } from "@/modules/platform/queries";
import { RoleEditor } from "@/modules/platform/ui/role-editor";

/**
 * `/admin/settings/roles/[key]` (`users.manage`): the permission checklist grouped by module with
 * the catalogue descriptions (`<module>.permissions.<permission with _>`); `persons.sensitive_read`
 * only for an owner actor; the owner role is read-only. Unknown permissions are listed (PL-18).
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
  const describe = (permission: string) => {
    const [module] = permission.split(".");
    const k = `${module}.permissions.${permission.replace(/\./g, "_")}`;
    const text = soft(k);
    return text === k ? "" : text;
  };
  const moduleLabel = (module: string) => {
    const k = `platform.role_editor.module_${module}`;
    return soft(k) === k ? module : soft(k);
  };
  const groups = role.groups.map((g) => ({ module: g.module, label: moduleLabel(g.module), permissions: g.permissions.map((p) => ({ key: p, description: describe(p) })) }));

  return (
    <div className="grid gap-6">
      <header className="grid gap-2">
        <Link href="/admin/settings/roles" className="text-sm text-muted-foreground hover:underline">
          {t("back")}
        </Link>
        <h1 className="text-2xl font-semibold">{tr(`platform.roles.${role.key}`)}</h1>
        <p className="text-muted-foreground">{role.isOwner ? t("owner_read_only") : t("edit_intro")}</p>
      </header>
      {role.unknownPermissions.length ? (
        <Alert role="status">
          <AlertDescription>
            {t("unknown_on_role")} <span className="font-mono text-xs">{role.unknownPermissions.join(", ")}</span>
          </AlertDescription>
        </Alert>
      ) : null}
      <RoleEditor
        roleKey={role.key}
        granted={role.isOwner ? groups.flatMap((g) => g.permissions.map((p) => p.key)) : role.permissions.filter((p) => !role.unknownPermissions.includes(p))}
        groups={groups}
        actorIsOwner={actor.roleKey === "owner"}
        readOnly={role.isOwner}
        labels={catalogueSection(locale, "platform.role_editor")}
        errors={catalogueSection(locale, "platform.errors")}
      />
    </div>
  );
}
