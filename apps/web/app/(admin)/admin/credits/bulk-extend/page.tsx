import Link from "next/link";
import { Badge, EmptyState, Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@beam/ui";
import { formatDateTime } from "@beam/core/i18n";
import { requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { creditsLabels, listBulkExtensions } from "@/modules/credits/queries";
import { BulkExtendForm } from "@/modules/credits/ui/bulk-extend-form";

/** `/admin/credits/bulk-extend` (`credits.adjust`, rule 32a): the form with live preview and the past bulk extensions. */
export default async function BulkExtendPage() {
  await requireStaff({ permission: "credits.adjust" });
  const locale = await adminLocale();
  const tr = translator(locale);
  const b = (k: string, p?: Record<string, string | number>) => tr(`credits.admin.bulk_extend.${k}`, p);
  const rows = await listBulkExtensions(await getAppDb(), { limit: 50 });
  const labels = creditsLabels(locale, ["admin.common", "admin.bulk_extend", "errors", "enum.kind", "enum.source"]);
  return (
    <div className="grid gap-6">
      <header className="grid gap-2">
        <Link href="/admin/credits" className="text-sm text-muted-foreground hover:underline">
          {tr("credits.admin.grant.back")}
        </Link>
        <h1 className="text-2xl font-semibold">{b("title")}</h1>
        <p className="max-w-prose text-muted-foreground">{b("intro")}</p>
      </header>
      <BulkExtendForm labels={labels} />
      <section className="grid gap-3">
        <h2 className="text-lg font-semibold">{b("history")}</h2>
        {rows.length === 0 ? (
          <EmptyState title={b("empty")} />
        ) : (
          <Table>
            <TableCaption>{b("history")}</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead>{b("col_created")}</TableHead>
                <TableHead>{b("col_reason")}</TableHead>
                <TableHead className="text-right">{b("col_days")}</TableHead>
                <TableHead>{b("col_status")}</TableHead>
                <TableHead className="text-right">{b("col_counts")}</TableHead>
                <TableHead>{b("col_by")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="whitespace-nowrap">{formatDateTime(r.createdAt, locale, "short")}</TableCell>
                  <TableCell className="max-w-72 break-words">{r.reason}</TableCell>
                  <TableCell className="text-right tabular-nums">{r.days}</TableCell>
                  <TableCell>
                    <Badge variant={r.status === "done" ? "success" : r.status === "failed" ? "destructive" : "outline"}>{tr(`credits.enum.bulk_status.${r.status}`)}</Badge>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{b("counts", { extended: r.extendedCount, matched: r.matchedCount })}</TableCell>
                  <TableCell>{r.createdByName ?? tr("credits.admin.common.none")}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>
    </div>
  );
}
