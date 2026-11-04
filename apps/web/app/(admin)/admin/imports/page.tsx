import Link from "next/link";
import { Badge, buttonVariants, EmptyState } from "@beam/ui";
import { requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { getCutoverChecklist, listImports } from "@/modules/ops/imports/queries";

/**
 * `/admin/imports` (`persons.write`, ops spec 5): every import with kind, source, status, counts
 * and who created it, and the cut-over checklist progress bar.
 */
export default async function ImportsPage({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  await requireStaff({ permission: "persons.write" });
  const sp = await searchParams;
  const locale = await adminLocale();
  const tr = translator(locale);
  const db = await getAppDb();
  const [list, cutover] = await Promise.all([listImports(db, { page: Number(sp.page) || 1 }), getCutoverChecklist(db)]);
  const fmt = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Brussels" });
  const pct = Math.round((cutover.done / cutover.total) * 100);

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">{tr("ops.imports.title")}</h1>
        <Link href="/admin/imports/new" className={buttonVariants()}>
          {tr("ops.imports.new")}
        </Link>
      </div>

      <Link href="/admin/imports/cutover" className="grid max-w-xl gap-2 rounded-md border p-4 hover:bg-muted/40">
        <span className="font-medium">{tr("ops.cutover.title")}</span>
        <div className="h-2 w-full overflow-hidden rounded bg-muted" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <div className="h-full bg-primary" style={{ width: `${pct}%` }} />
        </div>
        <span className="text-sm text-muted-foreground">{tr("ops.cutover.progress", { done: cutover.done, total: cutover.total })}</span>
      </Link>

      {list.items.length === 0 ? (
        <EmptyState title={tr("ops.imports.empty")} />
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left">
              <tr>
                <th className="px-3 py-2">{tr("ops.imports.target.name")}</th>
                <th className="px-3 py-2">{tr("platform.jobs.col_kind")}</th>
                <th className="px-3 py-2">{tr("ops.imports.target.source")}</th>
                <th className="px-3 py-2">{tr("platform.jobs.col_status")}</th>
                <th className="px-3 py-2">{tr("ops.imports.row_status.imported")}</th>
                <th className="px-3 py-2">{tr("ops.imports.row_status.updated")}</th>
                <th className="px-3 py-2">{tr("ops.imports.row_status.skipped")}</th>
                <th className="px-3 py-2">{tr("ops.imports.row_status.error")}</th>
                <th className="px-3 py-2">{tr("platform.audit.actor")}</th>
                <th className="px-3 py-2">{tr("platform.audit.col_when")}</th>
              </tr>
            </thead>
            <tbody>
              {list.items.map((i) => (
                <tr key={i.id} className="border-t">
                  <td className="px-3 py-2">
                    <Link href={`/admin/imports/${i.id}`} className="font-medium underline-offset-4 hover:underline">
                      {i.name}
                    </Link>
                  </td>
                  <td className="px-3 py-2">{tr(`ops.imports.kind.${i.kind}`)}</td>
                  <td className="px-3 py-2">{tr(`ops.imports.source.${i.source}`)}</td>
                  <td className="px-3 py-2">
                    <Badge variant={i.status === "failed" ? "destructive" : i.status === "done" ? "success" : "secondary"}>{tr(`ops.imports.status.${i.status}`)}</Badge>
                  </td>
                  <td className="px-3 py-2">{i.counts.imported ?? 0}</td>
                  <td className="px-3 py-2">{i.counts.updated ?? 0}</td>
                  <td className="px-3 py-2">{i.counts.skipped ?? 0}</td>
                  <td className="px-3 py-2">{i.counts.error ?? 0}</td>
                  <td className="px-3 py-2">{i.createdBy ?? "-"}</td>
                  <td className="px-3 py-2">{fmt.format(i.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {list.total > list.pageSize ? (
        <nav className="flex gap-2 text-sm" aria-label={tr("platform.table.pagination")}>
          {list.page > 1 ? <Link href={{ pathname: "/admin/imports", query: { page: list.page - 1 } }}>{tr("platform.table.previous")}</Link> : null}
          {list.page * list.pageSize < list.total ? <Link href={{ pathname: "/admin/imports", query: { page: list.page + 1 } }}>{tr("platform.table.next")}</Link> : null}
        </nav>
      ) : null}
    </div>
  );
}
