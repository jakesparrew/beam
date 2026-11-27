import type { Route } from "next";
import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { cn } from "@beam/ui";
import { hasPermission, requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale } from "@/lib/i18n";
import { getInvoicingIdentity } from "@/modules/finance/queries";
import { financeLabels } from "@/modules/finance/ui/labels";
import { fillLabel } from "@/modules/finance/ui/text";
import { PageHeader, SecondaryAction, StatusPill, Surface, td, th } from "@/modules/platform/ui/admin-kit";
import { Notice } from "@/modules/platform/ui/admin-list-kit";

function Block({ title, rows }: { title: string; rows: [string, ReactNode][] }) {
  return (
    <Surface className="grid content-start gap-3 p-4">
      <h2 className="text-[0.8125rem] font-semibold">{title}</h2>
      <dl className="grid gap-1.5 text-[0.8125rem]">
        {rows.map(([label, value]) => (
          <div key={label} className="grid grid-cols-[minmax(10rem,auto)_1fr] gap-3">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="min-w-0 break-words">{value}</dd>
          </div>
        ))}
      </dl>
    </Surface>
  );
}

/**
 * `/admin/finance/settings` (`invoices.read`; "Facturatie" under Instellingen in the menu):
 * read-only summary of what the next invoice will carry (finance spec section 5 and 8). Editing
 * happens in platform's generic settings editor (`settings.write`).
 */
export default async function FinanceSettingsPage() {
  const actor = await requireStaff();
  if (!hasPermission(actor, "invoices.read")) notFound();
  const canEditSettings = hasPermission(actor, "settings.write");
  const locale = await adminLocale();
  const labels = financeLabels(locale);
  const l = (key: string, p?: Record<string, string | number>) => fillLabel(labels[key] ?? key, p);
  const id = await getInvoicingIdentity(await getAppDb(), { locale });
  const s = id.seller;
  const fieldLabel = (path: string) => labels[`settings.field.${path.split(".").pop()}`] ?? path;
  const value = (v: string) => (v.trim() ? v : <span className="font-semibold text-[var(--status-bad)]">{l("common.none")}</span>);
  const onOff = (v: boolean) => <StatusPill tone={v ? "ok" : "muted"}>{v ? l("settings.on") : l("settings.off")}</StatusPill>;

  const seller: [string, ReactNode][] = (
    [
      ["legal_name", s.legal_name],
      ["trade_name", s.trade_name],
      ["vat_number", s.vat_number],
      ["enterprise_number", s.enterprise_number],
      ["street", s.address.line1],
      ["postal_code", s.address.postal_code],
      ["city", s.address.city],
      ["support_email", s.support_email],
      ["phone", s.phone],
      ["website", s.website],
      ["register_court", s.register_court],
      ["iban", s.iban],
      ["bic", s.bic],
      ["invoice_footer", s.footer],
    ] as const
  ).map(([key, v]) => [l(`settings.field.${key}`), value(v)]);
  const current: [string, ReactNode][] = [
    [l("settings.payment_terms"), l("settings.days", { count: id.settings.payment_terms_days })],
    [l("settings.request_window"), l("settings.days", { count: id.settings.company_request_window_days })],
    [l("settings.billit"), onOff(id.settings.billit_enabled)],
    [l("settings.peppol"), onOff(id.settings.peppol_enabled)],
    [l("settings.alert_after"), l("common.minutes", { count: id.settings.alert_after_minutes })],
  ];

  return (
    <div className="grid gap-4">
      <PageHeader
        title={l("settings.title")}
        description={l("settings.subtitle")}
        actions={
          canEditSettings ? (
            <>
              <SecondaryAction href={"/admin/settings/company" as Route}>{l("settings.edit_company")}</SecondaryAction>
              <SecondaryAction href={"/admin/settings/finance" as Route}>{l("settings.edit_finance")}</SecondaryAction>
            </>
          ) : null
        }
      />

      {id.missing.length > 0 ? (
        <Notice tone="bad">
          <strong>{l("settings.missing")}:</strong> {id.missing.map(fieldLabel).join(", ")}
        </Notice>
      ) : (
        <Notice tone="ok">{l("settings.complete")}</Notice>
      )}

      <div className="grid items-start gap-4 lg:grid-cols-2">
        <Block title={l("settings.seller")} rows={seller} />
        <div className="grid gap-4">
          <Block title={l("settings.current")} rows={current} />
          <Surface flush>
            <h2 className="border-b border-border px-5 py-3 text-[0.8125rem] font-semibold">{l("settings.vat_notes")}</h2>
            {id.vatNotes.length === 0 ? (
              <p className="px-5 py-3 text-[0.8125rem] text-muted-foreground">{l("settings.no_notes")}</p>
            ) : (
              <table className="w-full text-[0.8125rem]">
                <caption className="sr-only">{l("settings.vat_notes_caption")}</caption>
                <thead className="bg-[#faf9f6]">
                  <tr className="border-b border-border">
                    <th scope="col" className={th}>{l("settings.col_category")}</th>
                    <th scope="col" className={cn(th, "w-48")}>{l("settings.col_complete")}</th>
                  </tr>
                </thead>
                <tbody>
                  {id.vatNotes.map((n) => (
                    <tr key={n.category} className="border-b border-border last:border-b-0">
                      <td className={cn(td, "font-medium")}>{n.category}</td>
                      <td className={td}>
                        <StatusPill tone={n.complete ? "ok" : "bad"}>{n.complete ? l("settings.note_complete") : l("settings.note_incomplete", { locales: n.missingLocales.join(", ") })}</StatusPill>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Surface>
        </div>
      </div>
    </div>
  );
}
