import type { Route } from "next";
import Link from "next/link";
import { cn, EmptyState } from "@beam/ui";
import { requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { catalogueSection, listRoles, listStaffUsers } from "@/modules/platform/queries";
import { PageHeader, SecondaryAction, Segmented, StatusPill, Surface, Toolbar, td, th } from "@/modules/platform/ui/admin-kit";
import { Disclosure, Field, fieldClass, Initials, rowClass, rowLink, SearchField } from "@/modules/platform/ui/admin-list-kit";
import { InviteUserForm } from "@/modules/platform/ui/user-form";

type Search = { q?: string; role?: string; status?: string; cursor?: string };

/**
 * `/admin/settings/users` (`users.manage`), "Team" in the menu, in the back-office kit (owner
 * review, November 2026): a search, Active | Disabled tabs and the role behind "Filters", the
 * staff users with role, MFA, last login, status and lock (a row opens the user), then the invite
 * form.
 */
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
  const q = sp.q?.trim().slice(0, 100) || undefined;
  const { rows, nextCursor } = await listStaffUsers(db, { ...(q ? { q } : {}), ...(roleKey ? { roleKey } : {}), ...(status ? { status } : {}), cursor: sp.cursor ?? null });
  const roleLabel = (k: string) => allRoles.find((r) => r.key === k)?.label ?? k;
  const now = new Date().getTime();
  const when = (d: Date | null) => (d ? d.toLocaleString(locale, { timeZone: "Europe/Brussels", dateStyle: "short", timeStyle: "short" }) : "–");
  // Only an owner may create owners (PL-16); the form never offers it to anyone else.
  const roles = allRoles.filter((r) => r.key !== "owner" || actor.roleKey === "owner").map((r) => ({ key: r.key, label: r.label }));
  const href = (patch: Record<string, string | undefined>): Route => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ q, role: roleKey, status, ...patch })) if (v) p.set(k, v);
    const s = p.toString();
    return s ? `/admin/settings/users?${s}` : "/admin/settings/users";
  };

  return (
    <div className="grid gap-4">
      <PageHeader title={t("title")} description={t("intro")} />
      <form data-auto-filter="" method="get" role="search">
        <Toolbar>
          {status ? <input type="hidden" name="status" value={status} /> : null}
          <SearchField label={t("search")} placeholder={t("search_placeholder")} defaultValue={q} />
          <Segmented
            label={t("col_status")}
            items={[
              { key: "all", label: t("all_statuses"), href: href({ status: undefined, cursor: undefined }), active: !status },
              { key: "active", label: t("status_active"), href: href({ status: "active", cursor: undefined }), active: status === "active" },
              { key: "disabled", label: t("status_disabled"), href: href({ status: "disabled", cursor: undefined }), active: status === "disabled" },
            ]}
          />
          <Disclosure label={tr("platform.table.filters")} count={roleKey ? 1 : 0} clear={roleKey ? { href: href({ role: undefined }), label: t("all_roles") } : null}>
            <Field label={t("role")}>
              <select id="users-role" name="role" defaultValue={roleKey ?? ""} className={fieldClass}>
                <option value="">{t("all_roles")}</option>
                {allRoles.map((r) => (
                  <option key={r.key} value={r.key}>
                    {r.label}
                  </option>
                ))}
              </select>
            </Field>
          </Disclosure>
        </Toolbar>
      </form>

      {rows.length === 0 ? (
        <EmptyState title={t("empty")} />
      ) : (
        <Surface flush>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[48rem] text-[0.8125rem]">
              <caption className="sr-only">{t("title")}</caption>
              <thead className="bg-[#faf9f6]">
                <tr className="border-b border-border">
                  <th scope="col" className={th}>{t("name")}</th>
                  <th scope="col" className={cn(th, "w-44")}>{t("role")}</th>
                  <th scope="col" className={cn(th, "w-24")}>{t("col_mfa")}</th>
                  <th scope="col" className={cn(th, "w-40")}>{t("col_last_login")}</th>
                  <th scope="col" className={cn(th, "w-52")}>{t("col_status")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className={rowClass}>
                    <td className={td}>
                      <span className="flex items-center gap-2.5">
                        <Initials name={r.name ?? r.email} />
                        <span className="grid min-w-0 leading-tight">
                          <Link href={`/admin/settings/users/${r.id}`} className={cn(rowLink, "font-semibold hover:underline")}>
                            {r.name ?? r.email}
                          </Link>
                          <span className="truncate text-[0.75rem] text-muted-foreground">{r.email}</span>
                        </span>
                      </span>
                    </td>
                    <td className={td}>{roleLabel(r.roleKey)}</td>
                    <td className={td}>{r.mfaEnrolledAt ? <StatusPill tone="ok">{t("mfa_on")}</StatusPill> : <StatusPill tone="warn">{t("mfa_off")}</StatusPill>}</td>
                    <td className={cn(td, "whitespace-nowrap text-muted-foreground tabular-nums")}>{when(r.lastLoginAt)}</td>
                    <td className={td}>
                      <span className="flex flex-wrap gap-1">
                        <StatusPill tone={r.status === "active" ? "ok" : "bad"}>{t(`status_${r.status}`)}</StatusPill>
                        {r.invitePending ? <StatusPill tone="gold">{t("invite_pending")}</StatusPill> : null}
                        {r.lockedUntil && r.lockedUntil.getTime() > now ? <StatusPill tone="bad">{t("locked")}</StatusPill> : null}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Surface>
      )}
      {sp.cursor || nextCursor ? (
        <nav className="flex gap-2" aria-label={tr("platform.table.pagination")}>
          {sp.cursor ? <SecondaryAction href={href({ cursor: undefined })}>{tr("platform.table.previous")}</SecondaryAction> : null}
          {nextCursor ? <SecondaryAction href={href({ cursor: nextCursor })}>{tr("platform.table.next")}</SecondaryAction> : null}
        </nav>
      ) : null}

      <InviteUserForm roles={roles} labels={catalogueSection(locale, "platform.users")} errors={catalogueSection(locale, "platform.errors")} />
    </div>
  );
}
