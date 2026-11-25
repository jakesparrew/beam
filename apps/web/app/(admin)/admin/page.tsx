import { redirect } from "next/navigation";
import { hasPermission, requireStaff } from "@/lib/auth";
import { adminLocale, translator } from "@/lib/i18n";
import { NAV } from "@/registry/nav.generated";
import type { Permission } from "@/registry/types.generated";

type AdminNavEntry = { href: string; permission?: string; order: number; key: string };

/**
 * `/admin`: the main dashboard for everyone who may open it (`reports.read` or `tasks.all`, so
 * Front Desk too), else the first nav entry the user can open.
 */
export default async function AdminHome() {
  const actor = await requireStaff();
  if (hasPermission(actor, "reports.read") || hasPermission(actor, "tasks.all")) redirect("/admin/dashboard");
  const first = [...(NAV.admin as readonly AdminNavEntry[])]
    .sort((a, b) => a.order - b.order || a.key.localeCompare(b.key))
    .find((e) => (!e.permission || hasPermission(actor, e.permission as Permission)) && e.href !== "/admin");
  if (first) redirect(first.href as never);
  const tr = translator(await adminLocale());
  return (
    <section className="grid gap-2">
      <h1 className="text-2xl font-semibold">{tr("platform.shell.home_title")}</h1>
      <p className="text-muted-foreground">{tr("platform.shell.home_intro")}</p>
    </section>
  );
}
