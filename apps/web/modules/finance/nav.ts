/**
 * finance navigation (PL-19: an entry renders only when the user holds its permission). Facade read
 * by `pnpm gen:indexes`. finance-P5 adds the V1 back-office screens (finance spec section 5):
 * Overview, Invoices, Billit sync, Requests and Settings; finance-P7 adds Exports
 * (`reports.finance`) and the portal entry "Invoices" (`/account/invoices`, finance-P6's screen).
 * Dashboard and Deferred revenue (R3) come with their screens, so no entry links to a page that
 * does not exist. "Requests" shows the number of pending company invoice requests.
 */
import { sql, type DbOrTx } from "@/lib/ctx";
import { rowsOf } from "@/lib/sensitive";

async function pendingRequests({ db }: { db: DbOrTx }): Promise<number> {
  const [row] = rowsOf<{ n: number }>(await db.execute(sql`select count(*)::int as n from invoice_requests where status = 'requested'`));
  return Number(row?.n ?? 0);
}

export const nav = [
  {
    key: "finance.overview",
    area: "admin",
    section: "finance",
    labelKey: "finance.nav.overview",
    href: "/admin/finance",
    permission: "invoices.read",
    icon: "wallet",
    order: 500,
  },
  {
    key: "finance.invoices",
    area: "admin",
    section: "finance",
    labelKey: "finance.nav.invoices",
    href: "/admin/finance/invoices",
    permission: "invoices.read",
    icon: "receipt",
    order: 510,
  },
  {
    key: "finance.sync",
    area: "admin",
    section: "finance",
    labelKey: "finance.nav.sync",
    href: "/admin/finance/sync",
    permission: "invoices.read",
    icon: "repeat",
    order: 520,
  },
  {
    key: "finance.requests",
    area: "admin",
    section: "finance",
    labelKey: "finance.nav.requests",
    href: "/admin/finance/requests",
    permission: "invoices.read",
    icon: "inbox",
    order: 530,
    badge: pendingRequests,
  },
  {
    key: "finance.exports",
    area: "admin",
    section: "finance",
    labelKey: "finance.nav.exports",
    href: "/admin/finance/exports",
    permission: "reports.finance",
    icon: "file-text",
    order: 540,
  },
  {
    key: "finance.settings",
    area: "admin",
    section: "finance",
    labelKey: "finance.nav.settings",
    href: "/admin/finance/settings",
    permission: "invoices.read",
    icon: "settings",
    order: 590,
  },
  {
    key: "finance.my_invoices",
    area: "portal",
    section: "account",
    labelKey: "finance.portal.title",
    href: "/account/invoices",
    icon: "receipt",
    order: 40,
  },
] as const;
