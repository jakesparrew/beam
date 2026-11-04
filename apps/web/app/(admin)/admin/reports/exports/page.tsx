import Link from "next/link";
import { redirect } from "next/navigation";
import { Alert, AlertDescription, Badge, Button, buttonVariants, EmptyState, Input } from "@beam/ui";
import { EXPORT_ENTITIES, FINANCE_EXPORT_ENTITIES } from "@beam/core/ops";
import { hasPermission, requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { createExport } from "@/modules/ops/exports/actions";
import { listExports } from "@/modules/ops/exports/queries";

/**
 * `/admin/reports/exports` (`persons.export`, ops spec 5, rules 54-57): the export list (kind,
 * entity, status, rows, created by, expiry) and the new export form. A full export also needs
 * `users.manage`; invoices, payments and refunds also `invoices.read`. Download links are shown
 * to the creator and to `users.manage` while the export is ready.
 */
const ERROR_KEYS = new Set(["forbidden", "validation", "not_found", "conflict", "rate_limited"]);

export default async function ExportsPage({ searchParams }: { searchParams: Promise<{ page?: string; error?: string; created?: string }> }) {
  const actor = await requireStaff({ permission: "persons.export" });
  const sp = await searchParams;
  const locale = await adminLocale();
  const tr = translator(locale);
  const db = await getAppDb();
  const list = await listExports(db, { page: Number(sp.page) || 1 });
  const fmt = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Brussels" });
  const day = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "Europe/Brussels" });
  const canFull = hasPermission(actor, "users.manage");
  const canFinance = hasPermission(actor, "invoices.read");
  const entities = EXPORT_ENTITIES.filter((e) => canFinance || !(FINANCE_EXPORT_ENTITIES as readonly string[]).includes(e));
  const now = new Date();

  async function submit(fd: FormData) {
    "use server";
    const kind = fd.get("kind") === "full" ? "full" : "entity";
    const str = (k: string) => {
      const v = fd.get(k);
      return typeof v === "string" && v.trim() ? v.trim() : undefined;
    };
    const from = str("from");
    const to = str("to");
    const result = await createExport(
      kind === "full" ? { kind } : { kind, entity: str("entity") as (typeof EXPORT_ENTITIES)[number], ...(from || to ? { filters: { ...(from ? { from } : {}), ...(to ? { to } : {}) } } : {}) },
    );
    redirect((result.ok ? "/admin/reports/exports?created=1" : `/admin/reports/exports?error=${result.error.code}`) as never);
  }

  const error = sp.error && ERROR_KEYS.has(sp.error) ? sp.error : sp.error ? "validation" : null;

  return (
    <div className="grid gap-6">
      <h1 className="text-2xl font-semibold">{tr("ops.exports.title")}</h1>

      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{tr(`platform.errors.${error}`)}</AlertDescription>
        </Alert>
      ) : null}

      <form action={submit} className="grid max-w-3xl gap-4 rounded-md border p-4" aria-labelledby="new-export">
        <h2 id="new-export" className="text-lg font-medium">
          {tr("ops.exports.new")}
        </h2>
        <fieldset className="flex flex-wrap gap-4">
          <legend className="sr-only">{tr("platform.jobs.col_kind")}</legend>
          <label className="flex items-center gap-2 text-sm">
            <input type="radio" name="kind" value="entity" defaultChecked /> {tr("ops.exports.kind.entity")}
          </label>
          {canFull ? (
            <label className="flex items-center gap-2 text-sm">
              <input type="radio" name="kind" value="full" /> {tr("ops.exports.kind.full")}
            </label>
          ) : null}
        </fieldset>
        <div className="grid gap-4 sm:grid-cols-3">
          <label className="grid gap-1 text-sm font-medium">
            {tr("ops.exports.kind.entity")}
            <select name="entity" className="h-9 rounded-md border bg-background px-2 text-sm" defaultValue="persons">
              {entities.map((e) => (
                <option key={e} value={e}>
                  {tr(`ops.exports.entity.${e}`)}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1 text-sm font-medium">
            {tr("platform.audit.from")}
            <Input type="date" name="from" />
          </label>
          <label className="grid gap-1 text-sm font-medium">
            {tr("platform.audit.to")}
            <Input type="date" name="to" />
          </label>
        </div>
        <div>
          <Button type="submit">{tr("ops.exports.new")}</Button>
        </div>
      </form>

      {list.items.length === 0 ? (
        <EmptyState title={tr("ops.exports.empty")} />
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left">
              <tr>
                <th className="px-3 py-2">{tr("platform.jobs.col_kind")}</th>
                <th className="px-3 py-2">{tr("ops.exports.kind.entity")}</th>
                <th className="px-3 py-2">{tr("platform.jobs.col_status")}</th>
                <th className="px-3 py-2">{tr("platform.security.col_rows")}</th>
                <th className="px-3 py-2">{tr("platform.audit.actor")}</th>
                <th className="px-3 py-2">{tr("platform.audit.col_when")}</th>
                <th className="px-3 py-2">{tr("platform.jobs.col_actions")}</th>
              </tr>
            </thead>
            <tbody>
              {list.items.map((x) => {
                const ready = x.status === "done" && !!x.expiresAt && x.expiresAt > now;
                const mayDownload = ready && (x.createdByUserId === actor.userId || canFull);
                return (
                  <tr key={x.id} className="border-t">
                    <td className="px-3 py-2">{tr(`ops.exports.kind.${x.kind}`)}</td>
                    <td className="px-3 py-2">{x.entity ? tr(`ops.exports.entity.${x.entity}`) : "-"}</td>
                    <td className="px-3 py-2">
                      <Badge variant={x.status === "failed" ? "destructive" : x.status === "done" ? "success" : "secondary"}>{tr(`ops.exports.status.${x.status}`)}</Badge>
                    </td>
                    <td className="px-3 py-2">{x.rowCount}</td>
                    <td className="px-3 py-2">{x.createdBy ?? "-"}</td>
                    <td className="px-3 py-2">{fmt.format(x.createdAt)}</td>
                    <td className="px-3 py-2">
                      {mayDownload ? (
                        <span className="flex flex-wrap items-center gap-3">
                          <a href={`/admin/reports/exports/${x.id}/download`} className={buttonVariants({ variant: "outline", size: "sm" })} download>
                            {tr("ops.exports.download")}
                          </a>
                          <span className="text-muted-foreground">{tr("ops.exports.expires", { date: day.format(x.expiresAt!) })}</span>
                        </span>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {list.total > list.pageSize ? (
        <nav className="flex gap-2 text-sm" aria-label={tr("platform.table.pagination")}>
          {list.page > 1 ? <Link href={{ pathname: "/admin/reports/exports", query: { page: list.page - 1 } }}>{tr("platform.table.previous")}</Link> : null}
          {list.page * list.pageSize < list.total ? <Link href={{ pathname: "/admin/reports/exports", query: { page: list.page + 1 } }}>{tr("platform.table.next")}</Link> : null}
        </nav>
      ) : null}
    </div>
  );
}
