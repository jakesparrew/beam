import Link from "next/link";
import { Badge, Button, EmptyState, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@beam/ui";
import { NotImplementedError } from "@beam/core/errors";
import { hasPermission, requireStaff } from "@/lib/auth";
import { getAppDb, type DbOrTx } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { isSegmentInUse as automationUses } from "@/modules/automation/api";
import { isSegmentInUse as emailUses } from "@/modules/email/api";
import { listSegments } from "@/modules/crm/queries";
import { ArchiveSegmentButton } from "@/modules/crm/ui/segment-builder";

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
 * `/admin/segments` (`persons.read`; edit `email.write`), crm spec 5.1: name, kind, count, last
 * refreshed and used by (campaigns, automations), with create and archive.
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
  const createButton = canEdit ? (
    <Button asChild>
      <Link href="/admin/segments/new">{t("create")}</Link>
    </Button>
  ) : undefined;

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <div className="flex gap-2">
          <Button variant="ghost" asChild>
            <Link href={{ pathname: "/admin/segments", query: includeArchived ? {} : { archived: "1" } }}>{includeArchived ? tr("crm.common.back") : t("show_archived")}</Link>
          </Button>
          {createButton}
        </div>
      </div>
      {rows.length === 0 ? (
        <EmptyState title={t("empty")} action={createButton} />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("col_name")}</TableHead>
              <TableHead>{t("col_kind")}</TableHead>
              <TableHead className="text-right">{t("col_count")}</TableHead>
              <TableHead>{t("col_refreshed")}</TableHead>
              <TableHead>{t("col_used_by")}</TableHead>
              {canEdit ? <TableHead>{tr("crm.common.actions")}</TableHead> : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r, i) => {
              const used = usedBy[i] ?? [];
              return (
                <TableRow key={r.id}>
                  <TableCell>
                    <Link className="font-medium underline-offset-2 hover:underline" href={`/admin/segments/${r.id}`}>
                      {r.name}
                    </Link>
                    {r.refreshError ? (
                      <Badge variant="destructive" className="ml-2">
                        {tr("crm.common.error")}
                      </Badge>
                    ) : null}
                    {r.isArchived ? (
                      <Badge variant="secondary" className="ml-2">
                        {t("archive")}
                      </Badge>
                    ) : null}
                  </TableCell>
                  <TableCell>{tr(`crm.enums.segment_kind.${r.kind}`)}</TableCell>
                  <TableCell className="text-right tabular-nums">{r.lastCount ?? "—"}</TableCell>
                  <TableCell>{r.lastCountedAt ? dateFmt.format(r.lastCountedAt) : "—"}</TableCell>
                  <TableCell>{used.length ? used.join(", ") : "—"}</TableCell>
                  {canEdit ? (
                    <TableCell>
                      {!r.isArchived && !used.length ? (
                        <ArchiveSegmentButton segmentId={r.id} labels={{ archive: t("archive"), inUse: tr("crm.segments.builder.in_use", { name: tr("crm.nav.segments") }), error: tr("crm.common.error") }} />
                      ) : null}
                    </TableCell>
                  ) : null}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
