import Link from "next/link";
import { EmptyState } from "@beam/ui";
import { requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { catalogueSection, listStaffUsers, searchAudit } from "@/modules/platform/queries";
import { AuditExportButton, AuditResults, AuditSearchForm, type AuditFilters } from "@/modules/platform/ui/audit-search";

type Search = AuditFilters & { cursor?: string };

const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 200) : undefined);
const day = (v: unknown) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined);

/**
 * `/admin/system/audit` (`system.jobs`): audit search by actor, action (a trailing dot matches a
 * prefix), entity type and id, person and date range; keyset-paginated; rows expand to the old and
 * new values; CSV export of the filtered result (audited `audit.export`).
 */
export default async function AuditPage({ searchParams }: { searchParams: Promise<Search> }) {
  await requireStaff({ permission: "system.jobs" });
  const sp = await searchParams;
  const locale = await adminLocale();
  const tr = translator(locale);
  const t = (k: string) => tr(`platform.audit.${k}`);
  const db = await getAppDb();
  const filters: AuditFilters = Object.fromEntries(
    Object.entries({ actorId: text(sp.actorId), action: text(sp.action), entityType: text(sp.entityType), entityId: text(sp.entityId), personId: text(sp.personId), from: day(sp.from), to: day(sp.to) }).filter(([, v]) => v),
  );
  const [{ rows, nextCursor }, staff] = await Promise.all([
    searchAudit(db, {
      ...filters,
      from: filters.from ? new Date(`${filters.from}T00:00:00Z`) : undefined,
      to: filters.to ? new Date(new Date(`${filters.to}T00:00:00Z`).getTime() + 86_400_000) : undefined,
      cursor: sp.cursor ?? null,
    }),
    listStaffUsers(db),
  ]);
  const names = new Map(staff.rows.map((u) => [u.id, u.name ?? u.email]));
  const labels = catalogueSection(locale, "platform.audit");
  const actorName = (a: { kind: string; id?: string | null }) => (a.kind === "staff" && a.id ? (names.get(a.id) ?? a.id) : a.id ? `${a.kind}:${a.id}` : a.kind);
  const next = new URLSearchParams({ ...(filters as Record<string, string>), ...(nextCursor ? { cursor: nextCursor } : {}) });

  return (
    <div className="grid gap-6">
      <header className="grid gap-2">
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <p className="text-muted-foreground">{t("intro")}</p>
      </header>
      <AuditSearchForm filters={filters} staff={staff.rows.map((u) => ({ id: u.id, name: u.name ?? u.email }))} labels={labels} />
      <AuditExportButton filters={filters} labels={labels} errors={catalogueSection(locale, "platform.errors")} />
      {rows.length === 0 ? (
        <EmptyState title={t("empty")} />
      ) : (
        <AuditResults
          rows={rows.map((r) => ({
            id: r.id,
            actor: actorName(r.actor as { kind: string; id?: string | null }),
            action: r.action,
            entityType: r.entityType,
            entityId: r.entityId,
            personId: r.personId,
            oldValue: r.oldValue,
            newValue: r.newValue,
            createdAt: r.createdAt.toISOString(),
          }))}
          locale={locale}
          labels={labels}
        />
      )}
      {nextCursor ? (
        <nav aria-label={tr("platform.table.pagination")}>
          <Link href={`/admin/system/audit?${next.toString()}`} className="text-sm underline">
            {tr("platform.table.next")}
          </Link>
        </nav>
      ) : null}
    </div>
  );
}
