import type { Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cn, EmptyState } from "@beam/ui";
import { formatDate, formatMoney } from "@beam/core/i18n";
import { hasPermission, requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { getFinanceOverview, listInvoices, type InvoiceRow, type ListInvoicesInput } from "@/modules/finance/queries";
import { brusselsDay } from "@/modules/finance/service/billit-sync";
import { exportPresets } from "@/modules/finance/service/exports";
import { financeLabels } from "@/modules/finance/ui/labels";
import { invoicesExportHref } from "@/modules/finance/ui/links";
import { fillLabel } from "@/modules/finance/ui/text";
import { PageHeader, SecondaryAction, Segmented, StatusPill, Surface, Toolbar, td, th, type Tone } from "@/modules/platform/ui/admin-kit";
import { aboveRow, Disclosure, Field, fieldClass, Initials, KpiStrip, Notice, rowClass, rowLink, SearchField } from "@/modules/platform/ui/admin-list-kit";

type Search = { from?: string; to?: string; kind?: string; status?: string; billit?: string; b2b?: string; q?: string; cursor?: string };

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const KINDS = ["invoice", "credit_note"] as const;
/** The status tabs; `overdue` is an open invoice past its due date. `issued` (credit notes) stays a URL filter. */
const STATUS_TABS = ["open", "overdue", "paid", "cancelled"] as const;
const STATUSES = ["paid", "open", "cancelled", "issued", "overdue"] as const;
const BILLIT = ["pending", "synced", "failed"] as const;
const PERIODS = ["this_month", "last_month", "this_year", "last_year"] as const;

const pick = <T extends string>(list: readonly T[], v: string | undefined): T | undefined => ((list as readonly string[]).includes(v ?? "") ? (v as T) : undefined);

/**
 * `/admin/finance/invoices` (`invoices.read`, finance spec section 5; owner review November 2026):
 * the main finance page. This month's figures, one notice line per thing to follow up (Billit
 * backlog, company invoice requests, blocked PDFs), then the documents: a wide search on number or
 * customer, status tabs, the period and the rarely used filters (kind, Billit, customer type)
 * behind one disclosure, and a table whose rows open the document. Sync, requests, the overview
 * and the reports sit behind "More"; they left the menu.
 */
export default async function FinanceInvoicesPage({ searchParams }: { searchParams: Promise<Search> }) {
  const actor = await requireStaff();
  if (!hasPermission(actor, "invoices.read")) notFound();
  const sp = await searchParams;
  const locale = await adminLocale();
  const tr = translator(locale);
  const labels = financeLabels(locale);
  const l = (key: string, params?: Record<string, string | number>) => fillLabel(labels[key] ?? key, params);
  const money = (cents: number) => formatMoney(cents, locale);
  const canReport = hasPermission(actor, "reports.finance");

  const status = pick(STATUSES, sp.status);
  const kind = pick(KINDS, sp.kind);
  const billit = pick(BILLIT, sp.billit);
  const b2b = sp.b2b === "1" || sp.b2b === "0" ? sp.b2b : undefined;
  const from = sp.from && DAY.test(sp.from) ? sp.from : undefined;
  const to = sp.to && DAY.test(sp.to) ? sp.to : undefined;
  const q = sp.q?.trim().slice(0, 100) || undefined;
  const filter: ListInvoicesInput = {
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    ...(kind ? { kind } : {}),
    ...(status === "overdue" ? { overdue: true } : status ? { status } : {}),
    ...(billit ? { billitStatus: billit } : {}),
    ...(b2b ? { isCompany: b2b === "1" } : {}),
    ...(q ? { q } : {}),
  };
  const db = await getAppDb();
  const [page, o] = await Promise.all([listInvoices(db, { ...filter, ...(sp.cursor ? { cursor: sp.cursor } : {}) }), getFinanceOverview(db)]);

  const today = brusselsDay(new Date());
  const past = exportPresets(today);
  const presets: Record<(typeof PERIODS)[number], { from: string; to: string }> = {
    this_month: { from: `${today.slice(0, 7)}-01`, to: today },
    last_month: past.last_month,
    this_year: { from: `${today.slice(0, 4)}-01-01`, to: today },
    last_year: past.last_year,
  };
  const activePreset = PERIODS.find((p) => presets[p].from === from && presets[p].to === to);
  const periodValue = activePreset ? l(`invoices.period_${activePreset}`) : from || to ? `${from ? formatDate(from, locale) : "…"} – ${to ? formatDate(to, locale) : "…"}` : l("invoices.period_all");

  const current: Record<string, string | undefined> = { q, status, kind, from, to, billit, b2b };
  const href = (patch: Record<string, string | undefined>): Route => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...current, ...patch })) if (v) p.set(k, v);
    const s = p.toString();
    return s ? `/admin/finance/invoices?${s}` : "/admin/finance/invoices";
  };
  const moreFilters = [kind, billit, b2b].filter(Boolean).length;
  const nextHref = page.nextCursor ? href({ cursor: page.nextCursor }) : null;

  const pill = (r: InvoiceRow): { tone: Tone; label: string } => {
    if (r.kind === "credit_note") return { tone: "info", label: l("kind.credit_note") };
    if (r.status === "paid") return { tone: "ok", label: l("status.paid") };
    if (r.status === "open") return r.dueOn && r.dueOn < today ? { tone: "bad", label: l("overview.overdue") } : { tone: "warn", label: l("status.open") };
    return { tone: "muted", label: l(`status.${r.status}`) };
  };
  const billitTone: Record<InvoiceRow["billitStatus"], Tone> = { synced: "muted", pending: "muted", failed: "bad" };

  const more: { key: string; href: Route; label: string }[] = [
    { key: "overview", href: "/admin/finance", label: tr("finance.nav.overview") },
    ...(canReport ? [{ key: "dashboard", href: "/admin/finance/dashboard" as Route, label: l("dashboard.title") }] : []),
    ...(canReport ? [{ key: "deferred", href: "/admin/finance/deferred" as Route, label: tr("finance.nav.deferred") }] : []),
    { key: "sync", href: "/admin/finance/sync", label: tr("finance.nav.sync") },
    { key: "requests", href: "/admin/finance/requests", label: tr("finance.nav.requests") },
    // The Lightspeed food-and-drink totals are a finance report too (`reports.finance` without `commerce.sell`).
    ...(canReport ? [{ key: "lightspeed", href: "/admin/pos/lightspeed" as Route, label: tr("commerce.nav.lightspeed") }] : []),
  ];

  return (
    <div className="grid gap-4">
      <PageHeader
        title={tr("finance.nav.invoices")}
        description={l("invoices.subtitle")}
        actions={
          <>
            {canReport ? <SecondaryAction href={invoicesExportHref(filter)}>{l("invoices.export_short")}</SecondaryAction> : null}
            <Disclosure label={l("invoices.more")} align="right">
              <ul className="grid gap-0.5 text-[0.8125rem]">
                {more.map((m) => (
                  <li key={m.key}>
                    <Link href={m.href} className="block rounded-md px-2 py-1.5 font-medium hover:bg-muted">
                      {m.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </Disclosure>
          </>
        }
      />

      {o.documentCount > 0 ? (
        <KpiStrip
          data-testid="invoices-kpis"
          items={[
            { key: "month", label: l("invoices.kpi_month"), value: money(o.month.netCents), sub: l("invoices.kpi_month_sub", { count: o.month.count }), href: href({ from: presets.this_month.from, to: presets.this_month.to, status: undefined, kind: undefined }) },
            { key: "open", label: l("invoices.kpi_open"), value: money(o.open.amountCents), sub: l("invoices.kpi_count", { count: o.open.count }), href: href({ status: "open", kind: undefined }), ...(o.open.count ? { tone: "warn" as const } : {}) },
            { key: "overdue", label: l("overview.overdue"), value: money(o.overdue.amountCents), sub: l("invoices.kpi_count", { count: o.overdue.count }), href: href({ status: "overdue", kind: undefined }), ...(o.overdue.count ? { tone: "bad" as const } : {}) },
          ]}
        />
      ) : null}

      {o.billit.failed + o.billit.pending > 0 ? (
        <Notice tone={o.billit.failed ? "bad" : "muted"} action={{ href: "/admin/finance/sync", label: tr("finance.nav.sync") }} data-testid="invoices-billit-notice">
          {l("overview.billit")}: {l("overview.billit_value", { pending: o.billit.pending, failed: o.billit.failed })}
          {o.billit.failing ? ` · ${l("overview.billit_failing", { count: o.billit.failing })}` : ""}
        </Notice>
      ) : null}
      {o.pendingRequests > 0 ? (
        <Notice tone="warn" action={{ href: "/admin/finance/requests", label: l("invoices.notice_requests_action") }} data-testid="invoices-requests-notice">
          {l("invoices.notice_requests", { count: o.pendingRequests })}
        </Notice>
      ) : null}
      {o.pdfBlocked ? (
        <Notice tone="bad" action={{ href: "/admin/finance/settings", label: l("settings.title") }}>
          {l("overview.pdf_blocked")}
        </Notice>
      ) : null}

      <form data-auto-filter="" method="get" role="search">
        <Toolbar>
          <SearchField label={l("invoices.search")} placeholder={l("invoices.search_placeholder")} defaultValue={q} />
          {status ? <input type="hidden" name="status" value={status} /> : null}
          <Segmented
            label={l("invoices.status")}
            items={[
              { key: "all", label: l("common.all"), href: href({ status: undefined }), active: !status },
              ...STATUS_TABS.map((s) => ({ key: s, label: s === "overdue" ? l("overview.overdue") : l(`status.${s}`), href: href({ status: s }), active: status === s })),
            ]}
          />
          <Disclosure label={l("invoices.period")} value={periodValue}>
            <ul className="flex flex-wrap gap-1.5 text-[0.8125rem]">
              <li>
                <Link href={href({ from: undefined, to: undefined })} aria-current={!from && !to ? "true" : undefined} className={cn("block rounded-md border border-border px-2.5 py-1 font-medium hover:bg-muted", !from && !to && "bg-muted")}>
                  {l("invoices.period_all")}
                </Link>
              </li>
              {PERIODS.map((p) => (
                <li key={p}>
                  <Link href={href(presets[p])} aria-current={activePreset === p ? "true" : undefined} className={cn("block rounded-md border border-border px-2.5 py-1 font-medium hover:bg-muted", activePreset === p && "bg-muted")}>
                    {l(`invoices.period_${p}`)}
                  </Link>
                </li>
              ))}
            </ul>
            <div className="grid grid-cols-2 gap-2">
              <Field label={l("invoices.from")}>
                <input id="fin-from" type="date" name="from" defaultValue={from ?? ""} className={fieldClass} />
              </Field>
              <Field label={l("invoices.to")}>
                <input id="fin-to" type="date" name="to" defaultValue={to ?? ""} className={fieldClass} />
              </Field>
            </div>
          </Disclosure>
          <Disclosure label={l("invoices.filters")} count={moreFilters} clear={moreFilters ? { href: href({ kind: undefined, billit: undefined, b2b: undefined }), label: l("common.clear") } : null}>
            <Field label={l("invoices.kind")}>
              <select id="fin-kind" name="kind" defaultValue={kind ?? ""} className={fieldClass}>
                <option value="">{l("common.all")}</option>
                {KINDS.map((k) => (
                  <option key={k} value={k}>
                    {l(`kind.${k}`)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={l("invoices.billit")}>
              <select id="fin-billit" name="billit" defaultValue={billit ?? ""} className={fieldClass}>
                <option value="">{l("common.all")}</option>
                {BILLIT.map((s) => (
                  <option key={s} value={s}>
                    {l(`billit_status.${s}`)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={l("invoices.b2b")}>
              <select id="fin-b2b" name="b2b" defaultValue={b2b ?? ""} className={fieldClass}>
                <option value="">{l("common.all")}</option>
                <option value="1">{l("invoices.b2b_only")}</option>
                <option value="0">{l("invoices.b2c_only")}</option>
              </select>
            </Field>
          </Disclosure>
        </Toolbar>
      </form>

      {page.rows.length === 0 ? (
        <EmptyState title={o.documentCount === 0 ? l("overview.empty", { year: today.slice(0, 4) }) : l("invoices.empty")} />
      ) : (
        <Surface flush data-testid="invoices-list">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[52rem] text-[0.8125rem]">
              <caption className="sr-only">{l("invoices.caption")}</caption>
              <thead className="bg-[#faf9f6]">
                <tr className="border-b border-border">
                  <th scope="col" className={cn(th, "w-40")}>{l("invoices.col_number")}</th>
                  <th scope="col" className={cn(th, "w-36")}>{l("invoices.col_date")}</th>
                  <th scope="col" className={th}>{l("invoices.col_customer")}</th>
                  <th scope="col" className={cn(th, "w-32 text-right")}>{l("invoices.col_total")}</th>
                  <th scope="col" className={cn(th, "w-28")}>{l("invoices.col_status")}</th>
                  <th scope="col" className={cn(th, "w-36")}>{l("invoices.col_billit")}</th>
                  <th scope="col" className={cn(th, "w-20")}>{l("invoices.col_pdf")}</th>
                </tr>
              </thead>
              <tbody>
                {page.rows.map((r) => {
                  const st = pill(r);
                  return (
                    <tr key={r.id} className={rowClass} data-testid="invoices-row">
                      <td className={cn(td, "font-semibold whitespace-nowrap")}>
                        <Link href={`/admin/finance/invoices/${r.id}`} className={cn(rowLink, "hover:underline")}>
                          {r.number}
                        </Link>
                      </td>
                      <td className={cn(td, "whitespace-nowrap")}>
                        <span className="grid leading-tight">
                          <span>{formatDate(r.issuedOn, locale)}</span>
                          {r.status === "open" && r.dueOn ? <span className="text-[0.75rem] text-muted-foreground">{l("invoices.due", { date: formatDate(r.dueOn, locale) })}</span> : null}
                        </span>
                      </td>
                      <td className={td}>
                        <span className="flex items-center gap-2.5">
                          <Initials name={r.customerName} />
                          <span className="grid leading-tight">
                            <span className="font-medium">{r.customerName ?? l("common.none")}</span>
                            {r.isCompany ? <span className="text-[0.75rem] text-muted-foreground">{l("common.b2b")}</span> : null}
                          </span>
                        </span>
                      </td>
                      <td className={cn(td, "text-right font-semibold whitespace-nowrap tabular-nums")}>{money(r.totalCents)}</td>
                      <td className={td}>
                        <StatusPill tone={st.tone}>{st.label}</StatusPill>
                      </td>
                      <td className={td}>
                        <StatusPill tone={billitTone[r.billitStatus]}>{l(`billit_status.${r.billitStatus}`)}</StatusPill>
                      </td>
                      <td className={td}>
                        {r.pdfReady ? (
                          <a href={`/admin/finance/invoices/${r.id}/pdf`} target="_blank" rel="noopener" className={cn(aboveRow, "font-semibold hover:underline")} aria-label={`${l("invoices.pdf_ready")} ${r.number}`}>
                            {l("invoices.col_pdf")}
                          </a>
                        ) : (
                          <span className={cn("text-[0.75rem]", r.pdfStatus === "failed" ? "font-semibold text-[var(--status-bad)]" : "text-muted-foreground")}>{l(`pdf_status.${r.pdfStatus}`)}</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Surface>
      )}
      {sp.cursor || nextHref ? (
        <nav className="flex gap-2" aria-label={l("invoices.caption")}>
          {sp.cursor ? <SecondaryAction href={href({})}>{l("common.first_page")}</SecondaryAction> : null}
          {nextHref ? <SecondaryAction href={nextHref}>{l("common.next_page")}</SecondaryAction> : null}
        </nav>
      ) : null}
    </div>
  );
}
