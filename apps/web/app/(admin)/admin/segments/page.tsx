import Link from "next/link";
import { cn, EmptyState } from "@beam/ui";
import { NotImplementedError } from "@beam/core/errors";
import { hasPermission, requireStaff } from "@/lib/auth";
import { getAppDb, type DbOrTx } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { isSegmentInUse as automationUses } from "@/modules/automation/api";
import { isSegmentInUse as emailUses } from "@/modules/email/api";
import { listSegments } from "@/modules/crm/queries";
import { ArchiveSegmentButton } from "@/modules/crm/ui/segment-builder";
import { PageHeader, PrimaryAction, Segmented, StatusPill, Surface, td, th } from "@/modules/platform/ui/admin-kit";
import { aboveRow, rowClass, rowLink } from "@/modules/platform/ui/admin-list-kit";

/** A use check whose owner has not shipped yet counts as "not in use" (crm-P5). */
async function uses(check: (db: DbOrTx, id: string) => Promise<boolean>, db: DbOrTx, id: string): Promise<boolean> {
  try {
    return await check(db, id);
  } catch (error) {
    if (error instanceof NotImplementedError) return false;
    throw error;
  }
}

/**
 * `/admin/segments` (`persons.read`; edit `email.write`), crm spec 5.1, in the back-office kit
 * (owner review, November 2026): Active | Archived tabs, then name, kind, count, last refreshed
 * and used by (campaigns, automations); a row opens the segment, archive per unused row.
 */
export default async function SegmentsPage({ searchParams }: { searchParams: Promise<{ archived?: string }> }) {
  const actor = await requireStaff({ permission: "persons.read" });
  const sp = await searchParams;
  const includeArchived = sp.archived === "1";
  const locale = await adminLocale();
  const tr = translator(locale);
  const t = (k: string) => tr(`crm.segments.list.${k}`);
  const db = await getAppDb();
  const canEdit = hasPermission(actor, "email.write");
  const rows = await listSegments(db, { includeArchived });
  const usedBy = await Promise.all(
    rows.map(async (r) => [
      ...((await uses(emailUses, db, r.id)) ? [tr("crm.timeline.categories.email")] : []),
      ...((await uses(automationUses, db, r.id)) ? [tr("crm.timeline.categories.automation")] : []),
    ]),
  );
  const dateFmt = new Intl.DateTimeFormat(locale, { timeZone: "Europe/Brussels", dateStyle: "medium", timeStyle: "short" });

  return (
    <div className="grid gap-4">
      <PageHeader title={t("title")} description={t("subtitle")} actions={canEdit ? <PrimaryAction href="/admin/segments/new">+ {t("create")}</PrimaryAction> : null} />
      <Segmented
        label={t("title")}
        items={[
          { key: "active", label: t("active"), href: "/admin/segments", active: !includeArchived },
          { key: "archived", label: t("with_archived"), href: { pathname: "/admin/segments", query: { archived: "1" } }, active: includeArchived },
        ]}
      />
      {rows.length === 0 ? (
        <EmptyState title={t("empty")} />
      ) : (
        <Surface flush>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[48rem] text-[0.8125rem]">
              <caption className="sr-only">{t("title")}</caption>
              <thead className="bg-[#faf9f6]">
                <tr className="border-b border-border">
                  <th scope="col" className={th}>{t("col_name")}</th>
                  <th scope="col" className={cn(th, "w-40")}>{t("col_kind")}</th>
                  <th scope="col" className={cn(th, "w-28 text-right")}>{t("col_count")}</th>
                  <th scope="col" className={cn(th, "w-44")}>{t("col_refreshed")}</th>
                  <th scope="col" className={cn(th, "w-48")}>{t("col_used_by")}</th>
                  {canEdit ? (
                    <th scope="col" className={cn(th, "w-28")}>
                      <span className="sr-only">{tr("crm.common.actions")}</span>
                    </th>
                  ) : null}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => {
                  const used = usedBy[i] ?? [];
                  return (
                    <tr key={r.id} className={rowClass}>
                      <td className={td}>
                        <span className="flex flex-wrap items-center gap-2">
                          <Link className={cn(rowLink, "font-semibold hover:underline")} href={`/admin/segments/${r.id}`}>
                            {r.name}
                          </Link>
                          {r.refreshError ? <StatusPill tone="bad">{tr("crm.common.error")}</StatusPill> : null}
                          {r.isArchived ? <StatusPill tone="muted">{t("archived")}</StatusPill> : null}
                        </span>
                      </td>
                      <td className={cn(td, "text-muted-foreground")}>{tr(`crm.enums.segment_kind.${r.kind}`)}</td>
                      <td className={cn(td, "text-right font-semibold tabular-nums")}>{r.lastCount ?? "–"}</td>
                      <td className={cn(td, "whitespace-nowrap text-muted-foreground")}>{r.lastCountedAt ? dateFmt.format(r.lastCountedAt) : "–"}</td>
                      <td className={td}>{used.length ? used.join(", ") : <span className="text-muted-foreground">–</span>}</td>
                      {canEdit ? (
                        <td className={cn(td, "text-right")}>
                          {!r.isArchived && !used.length ? (
                            <span className={aboveRow}>
                              <ArchiveSegmentButton segmentId={r.id} labels={{ archive: t("archive"), inUse: tr("crm.segments.builder.in_use", { name: tr("crm.nav.segments") }), error: tr("crm.common.error") }} />
                            </span>
                          ) : null}
                        </td>
                      ) : null}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Surface>
      )}
    </div>
  );
}
