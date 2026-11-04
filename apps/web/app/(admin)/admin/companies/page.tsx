import Link from "next/link";
import { Badge, Button, buttonVariants, EmptyState, Input, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@beam/ui";
import type { CompanyStatus } from "@beam/core/crm";
import { hasPermission, requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { listCompanies } from "@/modules/crm/queries";
import { COMPANY_STATUSES } from "@/modules/crm/companies/queries";

/** `/admin/companies` (`persons.read`; create with `crm.b2b`), crm spec 5.1. */
export default async function CompaniesPage({ searchParams }: { searchParams: Promise<{ q?: string; status?: string; partner?: string }> }) {
  const actor = await requireStaff({ permission: "persons.read" });
  const sp = await searchParams;
  const locale = await adminLocale();
  const tr = translator(locale);
  const db = await getAppDb();
  const canEdit = hasPermission(actor, "crm.b2b");
  const status = (COMPANY_STATUSES as readonly string[]).includes(sp.status ?? "") ? (sp.status as CompanyStatus) : undefined;
  const q = sp.q?.trim().slice(0, 100);
  const rows = await listCompanies(db, { ...(q ? { q } : {}), ...(status ? { status } : {}), ...(sp.partner === "yes" ? { isPartner: true } : {}) });
  const c = (k: string) => tr(`crm.companies.${k}`);
  const filtered = !!(q || status || sp.partner);

  return (
    <div className="grid gap-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">{c("title")}</h1>
        {canEdit ? (
          <Link href="/admin/companies/new" className={buttonVariants()}>
            {c("create")}
          </Link>
        ) : null}
      </header>
      <form className="flex flex-wrap items-end gap-2" role="search">
        <Input name="q" defaultValue={q ?? ""} placeholder={c("search_placeholder")} aria-label={tr("crm.common.search")} className="max-w-sm" />
        <select
          name="status"
          defaultValue={status ?? ""}
          aria-label={c("col_status")}
          className="h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <option value="">{tr("crm.common.all")}</option>
          {COMPANY_STATUSES.map((s) => (
            <option key={s} value={s}>
              {tr(`crm.enums.company_status.${s}`)}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="partner" value="yes" defaultChecked={sp.partner === "yes"} />
          {c("col_partner")}
        </label>
        <Button type="submit" variant="outline">
          {tr("crm.common.search")}
        </Button>
        {filtered ? (
          <Link href="/admin/companies" className={buttonVariants({ variant: "ghost" })}>
            {tr("crm.common.clear_filters")}
          </Link>
        ) : null}
      </form>
      {rows.length === 0 ? (
        <EmptyState
          title={filtered ? tr("crm.common.none") : c("empty")}
          action={
            canEdit && !filtered ? (
              <Link href="/admin/companies/new" className={buttonVariants()}>
                {c("create")}
              </Link>
            ) : undefined
          }
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{c("col_name")}</TableHead>
              <TableHead>{c("col_vat")}</TableHead>
              <TableHead>{c("col_status")}</TableHead>
              <TableHead>{c("col_size")}</TableHead>
              <TableHead>{c("col_owner")}</TableHead>
              <TableHead className="text-right">{c("col_contacts")}</TableHead>
              <TableHead>{c("col_partner")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.id}>
                <TableCell>
                  <Link href={`/admin/companies/${r.id}`} className="font-medium underline-offset-4 hover:underline">
                    {r.name}
                  </Link>
                </TableCell>
                <TableCell className="font-mono text-sm">{r.vatNumber ?? "—"}</TableCell>
                <TableCell>
                  <Badge variant="outline">{tr(`crm.enums.company_status.${r.status}`)}</Badge>
                </TableCell>
                <TableCell>{r.size ? tr(`crm.enums.company_size.${r.size}`) : "—"}</TableCell>
                <TableCell>{r.ownerName ?? "—"}</TableCell>
                <TableCell className="text-right tabular-nums">{r.contacts}</TableCell>
                <TableCell>{r.isPartner ? <Badge variant="secondary">{c("col_partner")}</Badge> : null}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
