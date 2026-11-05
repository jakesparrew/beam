import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, Button, buttonVariants, EmptyState, Input, Label, Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@beam/ui";
import { formatDate, formatMoney } from "@beam/core/i18n";
import { hasPermission, requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale } from "@/lib/i18n";
import { listInvoices, type ListInvoicesInput } from "@/modules/finance/queries";
import { FinanceBadge } from "@/modules/finance/ui/badges";
import { financeLabels } from "@/modules/finance/ui/labels";
import { invoicesExportHref } from "@/modules/finance/ui/links";
import { fillLabel } from "@/modules/finance/ui/text";

type Search = { from?: string; to?: string; kind?: string; status?: string; billit?: string; b2b?: string; q?: string; cursor?: string };

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const KINDS = ["invoice", "credit_note"] as const;
const STATUSES = ["paid", "open", "cancelled", "issued"] as const;
const BILLIT = ["pending", "synced", "failed"] as const;
const selectClass = "h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

const pick = <T extends string>(list: readonly T[], v: string | undefined): T | undefined => (list as readonly string[]).includes(v ?? "") ? (v as T) : undefined;

/** `/admin/finance/invoices` (`invoices.read`): documents with filters and search (finance spec section 5). */
export default async function FinanceInvoicesPage({ searchParams }: { searchParams: Promise<Search> }) {
  const actor = await requireStaff();
  if (!hasPermission(actor, "invoices.read")) notFound();
  const sp = await searchParams;
  const locale = await adminLocale();
  const labels = financeLabels(locale);
  const l = (key: string, params?: Record<string, string | number>) => fillLabel(labels[key] ?? key, params);

  const filter: ListInvoicesInput = {
    ...(sp.from && DAY.test(sp.from) ? { from: sp.from } : {}),
    ...(sp.to && DAY.test(sp.to) ? { to: sp.to } : {}),
    ...(pick(KINDS, sp.kind) ? { kind: pick(KINDS, sp.kind) } : {}),
    ...(pick(STATUSES, sp.status) ? { status: pick(STATUSES, sp.status) } : {}),
    ...(pick(BILLIT, sp.billit) ? { billitStatus: pick(BILLIT, sp.billit) } : {}),
    ...(sp.b2b === "1" ? { isCompany: true } : sp.b2b === "0" ? { isCompany: false } : {}),
    ...(sp.q?.trim() ? { q: sp.q.trim().slice(0, 100) } : {}),
  };
  const page = await listInvoices(await getAppDb(), { ...filter, ...(sp.cursor ? { cursor: sp.cursor } : {}) });
  const filtered = Object.keys(filter).length > 0;
  const params = new URLSearchParams(Object.entries(sp).filter((e): e is [string, string] => e[0] !== "cursor" && typeof e[1] === "string" && e[1] !== ""));
  const nextHref = page.nextCursor ? `/admin/finance/invoices?${new URLSearchParams({ ...Object.fromEntries(params), cursor: page.nextCursor }).toString()}` : null;
  const exportHref = hasPermission(actor, "reports.finance") ? invoicesExportHref(filter) : null;

  return (
    <div className="grid gap-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">{l("invoices.title")}</h1>
        {exportHref ? (
          <Link href={exportHref} className={buttonVariants({ variant: "outline", size: "sm" })}>
            {l("invoices.export")}
          </Link>
        ) : null}
      </header>
      <form className="flex flex-wrap items-end gap-3" role="search">
        <div className="grid gap-1">
          <Label htmlFor="fin-from">{l("invoices.from")}</Label>
          <Input id="fin-from" type="date" name="from" defaultValue={filter.from ?? ""} />
        </div>
        <div className="grid gap-1">
          <Label htmlFor="fin-to">{l("invoices.to")}</Label>
          <Input id="fin-to" type="date" name="to" defaultValue={filter.to ?? ""} />
        </div>
        <div className="grid gap-1">
          <Label htmlFor="fin-kind">{l("invoices.kind")}</Label>
          <select id="fin-kind" name="kind" defaultValue={filter.kind ?? ""} className={selectClass}>
            <option value="">{l("common.all")}</option>
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {l(`kind.${k}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="grid gap-1">
          <Label htmlFor="fin-status">{l("invoices.status")}</Label>
          <select id="fin-status" name="status" defaultValue={filter.status ?? ""} className={selectClass}>
            <option value="">{l("common.all")}</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {l(`status.${s}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="grid gap-1">
          <Label htmlFor="fin-billit">{l("invoices.billit")}</Label>
          <select id="fin-billit" name="billit" defaultValue={filter.billitStatus ?? ""} className={selectClass}>
            <option value="">{l("common.all")}</option>
            {BILLIT.map((s) => (
              <option key={s} value={s}>
                {l(`billit_status.${s}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="grid gap-1">
          <Label htmlFor="fin-b2b">{l("invoices.b2b")}</Label>
          <select id="fin-b2b" name="b2b" defaultValue={sp.b2b === "1" || sp.b2b === "0" ? sp.b2b : ""} className={selectClass}>
            <option value="">{l("common.all")}</option>
            <option value="1">{l("invoices.b2b_only")}</option>
            <option value="0">{l("invoices.b2c_only")}</option>
          </select>
        </div>
        <div className="grid gap-1">
          <Label htmlFor="fin-q">{l("invoices.search")}</Label>
          <Input id="fin-q" type="search" name="q" defaultValue={filter.q ?? ""} maxLength={100} />
        </div>
        <Button type="submit" variant="outline">
          {l("common.filter")}
        </Button>
        {filtered ? (
          <Link href="/admin/finance/invoices" className={buttonVariants({ variant: "ghost" })}>
            {l("common.clear")}
          </Link>
        ) : null}
      </form>
      {page.rows.length === 0 ? (
        <EmptyState title={l("invoices.empty")} />
      ) : (
        <Table>
          <TableCaption>{l("invoices.caption")}</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead>{l("invoices.col_number")}</TableHead>
              <TableHead>{l("invoices.col_kind")}</TableHead>
              <TableHead>{l("invoices.col_date")}</TableHead>
              <TableHead>{l("invoices.col_customer")}</TableHead>
              <TableHead className="text-right">{l("invoices.col_total")}</TableHead>
              <TableHead>{l("invoices.col_status")}</TableHead>
              <TableHead>{l("invoices.col_billit")}</TableHead>
              <TableHead>{l("invoices.col_pdf")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {page.rows.map((r) => (
              <TableRow key={r.id}>
                <TableCell>
                  <Link href={`/admin/finance/invoices/${r.id}`} className="font-mono font-medium underline-offset-4 hover:underline">
                    {r.number}
                  </Link>
                </TableCell>
                <TableCell>
                  <Badge variant="outline">{l(`kind.${r.kind}`)}</Badge>
                </TableCell>
                <TableCell>{formatDate(r.issuedOn, locale)}</TableCell>
                <TableCell>
                  <span className="flex flex-wrap items-center gap-2">
                    {r.customerName ?? l("common.none")}
                    {r.isCompany ? <Badge variant="secondary">{l("common.b2b")}</Badge> : null}
                  </span>
                </TableCell>
                <TableCell className="text-right tabular-nums">{formatMoney(r.totalCents, locale)}</TableCell>
                <TableCell>
                  <FinanceBadge group="status" value={r.status} labels={labels} />
                </TableCell>
                <TableCell>
                  <FinanceBadge group="billit_status" value={r.billitStatus} labels={labels} />
                </TableCell>
                <TableCell>
                  {r.pdfReady ? (
                    <a href={`/admin/finance/invoices/${r.id}/pdf`} className="underline-offset-4 hover:underline" target="_blank" rel="noopener">
                      {l("invoices.pdf_ready")}
                    </a>
                  ) : (
                    <FinanceBadge group="pdf_status" value={r.pdfStatus} labels={labels} />
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <nav className="flex gap-2" aria-label={l("invoices.caption")}>
        {sp.cursor ? (
          <Link href={`/admin/finance/invoices?${params.toString()}` as "/admin/finance/invoices"} className={buttonVariants({ variant: "outline" })}>
            {l("common.first_page")}
          </Link>
        ) : null}
        {nextHref ? (
          <Link href={nextHref as "/admin/finance/invoices"} className={buttonVariants({ variant: "outline" })}>
            {l("common.next_page")}
          </Link>
        ) : null}
      </nav>
    </div>
  );
}
