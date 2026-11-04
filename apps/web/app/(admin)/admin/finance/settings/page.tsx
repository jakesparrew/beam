import Link from "next/link";
import { notFound } from "next/navigation";
import { Alert, AlertDescription, Badge, buttonVariants, Card, CardContent, CardHeader, CardTitle, Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@beam/ui";
import { hasPermission, requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale } from "@/lib/i18n";
import { getInvoicingIdentity } from "@/modules/finance/queries";
import { financeLabels } from "@/modules/finance/ui/labels";
import { fillLabel } from "@/modules/finance/ui/text";

/**
 * `/admin/finance/settings` (`invoices.read`): read-only summary of what the next invoice will
 * carry (finance spec section 5 and 8). Editing happens in platform's generic settings editor.
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
  const value = (v: string) => (v.trim() ? v : <span className="font-medium text-destructive">{l("common.none")}</span>);
  const onOff = (v: boolean) => <Badge variant={v ? "success" : "outline"}>{v ? l("settings.on") : l("settings.off")}</Badge>;

  const sellerRows: [string, React.ReactNode][] = [
    ["legal_name", value(s.legal_name)],
    ["trade_name", value(s.trade_name)],
    ["vat_number", value(s.vat_number)],
    ["enterprise_number", value(s.enterprise_number)],
    ["street", value(s.address.line1)],
    ["postal_code", value(s.address.postal_code)],
    ["city", value(s.address.city)],
    ["support_email", value(s.support_email)],
    ["phone", value(s.phone)],
    ["website", value(s.website)],
    ["register_court", value(s.register_court)],
    ["iban", value(s.iban)],
    ["bic", value(s.bic)],
    ["invoice_footer", value(s.footer)],
  ];

  return (
    <div className="grid gap-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">{l("settings.title")}</h1>
        {canEditSettings ? (
          <div className="flex flex-wrap gap-2">
            <Link href="/admin/settings/company" className={buttonVariants({ variant: "outline" })}>
              {l("settings.edit_company")}
            </Link>
            <Link href="/admin/settings/finance" className={buttonVariants({ variant: "outline" })}>
              {l("settings.edit_finance")}
            </Link>
          </div>
        ) : null}
      </header>

      {id.missing.length > 0 ? (
        <Alert variant="destructive">
          <AlertDescription>
            <strong>{l("settings.missing")}:</strong> {id.missing.map(fieldLabel).join(", ")}
          </AlertDescription>
        </Alert>
      ) : (
        <Alert>
          <AlertDescription>{l("settings.complete")}</AlertDescription>
        </Alert>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{l("settings.seller")}</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid gap-2 text-sm">
              {sellerRows.map(([key, v]) => (
                <div key={key} className="grid grid-cols-[minmax(10rem,auto)_1fr] gap-2">
                  <dt className="text-muted-foreground">{l(`settings.field.${key}`)}</dt>
                  <dd>{v}</dd>
                </div>
              ))}
            </dl>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{l("settings.current")}</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid gap-2 text-sm">
              <div className="grid grid-cols-[minmax(10rem,auto)_1fr] gap-2">
                <dt className="text-muted-foreground">{l("settings.payment_terms")}</dt>
                <dd>{l("settings.days", { count: id.settings.payment_terms_days })}</dd>
              </div>
              <div className="grid grid-cols-[minmax(10rem,auto)_1fr] gap-2">
                <dt className="text-muted-foreground">{l("settings.request_window")}</dt>
                <dd>{l("settings.days", { count: id.settings.company_request_window_days })}</dd>
              </div>
              <div className="grid grid-cols-[minmax(10rem,auto)_1fr] gap-2">
                <dt className="text-muted-foreground">{l("settings.billit")}</dt>
                <dd>{onOff(id.settings.billit_enabled)}</dd>
              </div>
              <div className="grid grid-cols-[minmax(10rem,auto)_1fr] gap-2">
                <dt className="text-muted-foreground">{l("settings.peppol")}</dt>
                <dd>{onOff(id.settings.peppol_enabled)}</dd>
              </div>
              <div className="grid grid-cols-[minmax(10rem,auto)_1fr] gap-2">
                <dt className="text-muted-foreground">{l("settings.alert_after")}</dt>
                <dd>{l("common.minutes", { count: id.settings.alert_after_minutes })}</dd>
              </div>
            </dl>
          </CardContent>
        </Card>
      </div>

      <section className="grid gap-3">
        <h2 className="text-lg font-semibold">{l("settings.vat_notes")}</h2>
        {id.vatNotes.length === 0 ? (
          <p className="text-sm text-muted-foreground">{l("settings.no_notes")}</p>
        ) : (
          <Table>
            <TableCaption>{l("settings.vat_notes_caption")}</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead>{l("settings.col_category")}</TableHead>
                <TableHead>{l("settings.col_complete")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {id.vatNotes.map((n) => (
                <TableRow key={n.category}>
                  <TableCell>{n.category}</TableCell>
                  <TableCell>
                    <Badge variant={n.complete ? "success" : "destructive"}>{n.complete ? l("settings.note_complete") : l("settings.note_incomplete", { locales: n.missingLocales.join(", ") })}</Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>
    </div>
  );
}
