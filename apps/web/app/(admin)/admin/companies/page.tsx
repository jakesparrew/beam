import type { Route } from "next";
import Link from "next/link";
import { cn, EmptyState } from "@beam/ui";
import type { CompanyStatus } from "@beam/core/crm";
import { hasPermission, requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { listCompanies } from "@/modules/crm/queries";
import { COMPANY_STATUSES } from "@/modules/crm/companies/queries";
import { PageHeader, PrimaryAction, StatusPill, Surface, td, th, type Tone } from "@/modules/platform/ui/admin-kit";
import { Field, fieldClass, Initials, ListToolbar, listToolbarLabels, rowClass, rowLink } from "@/modules/platform/ui/admin-list-kit";

const COMPANY_TONE: Record<CompanyStatus, Tone> = { target: "muted", prospect: "info", customer: "ok", partner: "gold", inactive: "muted" };
/** The statuses shown as toolbar chips; target and inactive sit in Filters. */
const CHIP_STATUSES = ["prospect", "customer", "partner"] as const satisfies readonly CompanyStatus[];

/**
 * `/admin/companies` (`persons.read`; create with `crm.b2b`), crm spec 5.1, in the back-office kit
 * (owner review, November 2026): the header with "New company", the list toolbar (search on name
 * or VAT number; prospect, customer and partner as chips; every status and "partners only" behind
 * "Filters") and the table whose rows open the company.
 */
export default async function CompaniesPage({ searchParams }: { searchParams: Promise<{ q?: string; status?: string; partner?: string }> }) {
  const actor = await requireStaff({ permission: "persons.read" });
  const sp = await searchParams;
  const locale = await adminLocale();
  const tr = translator(locale);
  const db = await getAppDb();
  const canEdit = hasPermission(actor, "crm.b2b");
  const status = (COMPANY_STATUSES as readonly string[]).includes(sp.status ?? "") ? (sp.status as CompanyStatus) : undefined;
  const q = sp.q?.trim().slice(0, 100) || undefined;
  const partner = sp.partner === "yes" ? "yes" : undefined;
  const rows = await listCompanies(db, { ...(q ? { q } : {}), ...(status ? { status } : {}), ...(partner ? { isPartner: true } : {}) });
  const c = (k: string) => tr(`crm.companies.${k}`);
  const filtered = !!(q || status || partner);
  const rareStatus = status && !(CHIP_STATUSES as readonly string[]).includes(status) ? status : undefined;
  const href = (patch: Record<string, string | undefined>): Route => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ q, status, partner, ...patch })) if (v) p.set(k, v);
    const s = p.toString();
    return s ? `/admin/companies?${s}` : "/admin/companies";
  };

  return (
    <div className="grid gap-4">
      <PageHeader title={c("title")} actions={canEdit ? <PrimaryAction href="/admin/companies/new">+ {c("create")}</PrimaryAction> : null} />

      <ListToolbar
        labels={listToolbarLabels(tr)}
        search={{ placeholder: c("search_placeholder"), defaultValue: q, label: tr("crm.common.search") }}
        filters={{
          count: [rareStatus, partner].filter(Boolean).length,
          children: (
            <>
              <Field label={c("col_status")}>
                <select name="status" defaultValue={status ?? ""} className={fieldClass}>
                  <option value="">{tr("crm.common.all")}</option>
                  {COMPANY_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {tr(`crm.enums.company_status.${s}`)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={c("col_partner")}>
                <select name="partner" defaultValue={partner ?? ""} className={fieldClass}>
                  <option value="">{tr("crm.common.all")}</option>
                  <option value="yes">{c("partners_only")}</option>
                </select>
              </Field>
            </>
          ),
        }}
        chips={{
          label: c("col_status"),
          items: [
            { key: "all", label: tr("crm.common.all"), href: href({ status: undefined }), active: !status },
            ...CHIP_STATUSES.map((s) => ({ key: s, label: tr(`crm.enums.company_status.${s}`), href: href({ status: s }), active: status === s })),
          ],
        }}
        applied={[
          ...(rareStatus ? [{ key: "status", label: c("col_status"), value: tr(`crm.enums.company_status.${rareStatus}`), href: href({ status: undefined }) }] : []),
          ...(partner ? [{ key: "partner", label: c("partners_only"), href: href({ partner: undefined }) }] : []),
        ]}
        clearAll={href({ status: rareStatus ? undefined : status, partner: undefined })}
      />

      {rows.length === 0 ? (
        <EmptyState title={filtered ? tr("crm.common.none") : c("empty")} action={canEdit && !filtered ? <Link href="/admin/companies/new">{c("create")}</Link> : undefined} />
      ) : (
        <Surface flush data-testid="companies-list">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[48rem] text-[0.8125rem]">
              <caption className="sr-only">{c("title")}</caption>
              <thead className="bg-[#faf9f6]">
                <tr className="border-b border-border">
                  <th scope="col" className={th}>{c("col_name")}</th>
                  <th scope="col" className={cn(th, "w-28")}>{c("col_status")}</th>
                  <th scope="col" className={cn(th, "w-28")}>{c("col_size")}</th>
                  <th scope="col" className={cn(th, "w-48")}>{c("col_owner")}</th>
                  <th scope="col" className={cn(th, "w-32 text-right")}>{c("col_contacts")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className={rowClass} data-testid="companies-row">
                    <td className={td}>
                      <span className="flex items-center gap-2.5">
                        <Initials name={r.name} />
                        <span className="grid leading-tight">
                          <span className="flex items-center gap-1.5">
                            <Link href={`/admin/companies/${r.id}`} className={cn(rowLink, "font-medium hover:underline")}>
                              {r.name}
                            </Link>
                            {r.isPartner && r.status !== "partner" ? <StatusPill tone="gold">{c("col_partner")}</StatusPill> : null}
                          </span>
                          <span className="text-[0.75rem] text-muted-foreground tabular-nums">{r.vatNumber ?? c("no_vat")}</span>
                        </span>
                      </span>
                    </td>
                    <td className={td}>
                      <StatusPill tone={COMPANY_TONE[r.status]}>{tr(`crm.enums.company_status.${r.status}`)}</StatusPill>
                    </td>
                    <td className={td}>{r.size ? tr(`crm.enums.company_size.${r.size}`) : <span className="text-muted-foreground">–</span>}</td>
                    <td className={td}>
                      {r.ownerName ? (
                        <span className="flex items-center gap-2">
                          <Initials name={r.ownerName} />
                          {r.ownerName}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">–</span>
                      )}
                    </td>
                    <td className={cn(td, "text-right font-semibold tabular-nums")}>{r.contacts}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Surface>
      )}
    </div>
  );
}
