import Link from "next/link";
import { Badge, DataTable, EmptyState } from "@beam/ui";
import { requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { catalogueSection, listRoles, listStaffUsers, type StaffUserRow } from "@/modules/platform/queries";
import { InviteUserForm } from "@/modules/platform/ui/user-form";

type Search = { q?: string; role?: string; status?: string; cursor?: string };

/** `/admin/settings/users` (`users.manage`): staff users with role, MFA, last login, status and lock; invite dialog. */
export default async function StaffUsersPage({ searchParams }: { searchParams: Promise<Search> }) {
  const actor = await requireStaff({ permission: "users.manage" });
  const sp = await searchParams;
  const locale = await adminLocale();
  const tr = translator(locale);
  const t = (k: string, p?: Record<string, string | number>) => tr(`platform.users.${k}`, p);
  const db = await getAppDb();
  const allRoles = await listRoles(db, locale);
  const roleKey = allRoles.some((r) => r.key === sp.role) ? sp.role : undefined;
  const status = sp.status === "active" || sp.status === "disabled" ? sp.status : undefined;
  const { rows, nextCursor } = await listStaffUsers(db, { ...(sp.q ? { q: sp.q } : {}), ...(roleKey ? { roleKey } : {}), ...(status ? { status } : {}), cursor: sp.cursor ?? null });
  const roleLabel = (k: string) => allRoles.find((r) => r.key === k)?.label ?? k;
  const now = new Date().getTime();
  const when = (d: Date | null) => (d ? d.toLocaleString(locale, { timeZone: "Europe/Brussels", dateStyle: "short", timeStyle: "short" }) : "–");
  // Only an owner may create owners (PL-16); the form never offers it to anyone else.
  const roles = allRoles.filter((r) => r.key !== "owner" || actor.roleKey === "owner").map((r) => ({ key: r.key, label: r.label }));

  return (
    <div className="grid gap-6">
      <header className="grid gap-2">
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <p className="text-muted-foreground">{t("intro")}</p>
      </header>
      <InviteUserForm roles={roles} labels={catalogueSection(locale, "platform.users")} errors={catalogueSection(locale, "platform.errors")} />
      <DataTable<StaffUserRow>
        rows={rows}
        nextCursor={nextCursor}
        searchParams={sp}
        caption={t("title")}
        filters={[
          { kind: "search", key: "q", label: t("search"), placeholder: t("search_placeholder") },
          { kind: "select", key: "role", label: t("role"), allLabel: t("all_roles"), options: allRoles.map((r) => ({ value: r.key, label: r.label })) },
          { kind: "select", key: "status", label: t("col_status"), allLabel: t("all_statuses"), options: [{ value: "active", label: t("status_active") }, { value: "disabled", label: t("status_disabled") }] },
        ]}
        labels={{ pagination: tr("platform.table.pagination"), previous: tr("platform.table.previous"), next: tr("platform.table.next"), applyFilters: tr("platform.table.apply"), filters: tr("platform.table.filters") }}
        emptyState={<EmptyState title={t("empty")} />}
        columns={[
          {
            key: "name",
            header: t("name"),
            cell: (r) => (
              <Link href={`/admin/settings/users/${r.id}`} className="font-medium hover:underline">
                {r.name ?? r.email}
              </Link>
            ),
          },
          { key: "email", header: t("email"), cell: (r) => r.email },
          { key: "role", header: t("role"), cell: (r) => roleLabel(r.roleKey) },
          { key: "mfa", header: t("col_mfa"), cell: (r) => (r.mfaEnrolledAt ? <Badge variant="success">{t("mfa_on")}</Badge> : <Badge variant="warning">{t("mfa_off")}</Badge>) },
          { key: "last_login", header: t("col_last_login"), cell: (r) => when(r.lastLoginAt) },
          {
            key: "status",
            header: t("col_status"),
            cell: (r) => (
              <span className="flex flex-wrap gap-1">
                <Badge variant={r.status === "active" ? "secondary" : "destructive"}>{t(`status_${r.status}`)}</Badge>
                {r.invitePending ? <Badge variant="outline">{t("invite_pending")}</Badge> : null}
                {r.lockedUntil && r.lockedUntil.getTime() > now ? <Badge variant="destructive">{t("locked")}</Badge> : null}
              </span>
            ),
          },
        ]}
      />
    </div>
  );
}
