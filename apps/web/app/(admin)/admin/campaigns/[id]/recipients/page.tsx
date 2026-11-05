import Link from "next/link";
import { notFound } from "next/navigation";
import { Button, EmptyState, Input, Label } from "@beam/ui";
import { RECIPIENT_EDIT_STATUSES, RECIPIENT_STATUSES, type RecipientStatus } from "@beam/core/email";
import { hasPermission, requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { catalogueSection, getCampaign, listCampaignRecipients } from "@/modules/email/queries";
import { clab } from "@/modules/email/ui/campaign/CampaignStepper";
import { RecipientsTable } from "@/modules/email/ui/campaign/RecipientsTable";

type Search = { status?: string; q?: string; page?: string };

/**
 * `/admin/campaigns/[id]/recipients` (`email.write` to view, `campaigns.send` for remove and
 * restore while `scheduled` or `paused`), email spec section 5: 50 per page with name, masked
 * email (unmasked with `persons.read`), locale, status, chunk and message status; filter by
 * status, search by name or email.
 */
export default async function CampaignRecipientsPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Search> }) {
  const actor = await requireStaff({ permission: "email.write" });
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const sp = await searchParams;
  const db = await getAppDb();
  const detail = await getCampaign(db, id);
  if (!detail) notFound();
  const c = detail.campaign;
  const status = (RECIPIENT_STATUSES as readonly string[]).includes(sp.status ?? "") ? (sp.status as RecipientStatus) : undefined;
  const page = Math.max(1, Number(sp.page) || 1);
  const list = await listCampaignRecipients(db, { campaignId: c.id, ...(status ? { status } : {}), ...(sp.q ? { q: sp.q } : {}), page }, { unmasked: hasPermission(actor, "persons.read") });
  const locale = await adminLocale();
  const tr = translator(locale);
  const labels = catalogueSection(locale, "email.campaigns");
  const localeNames = { "nl-BE": tr("email.editor.locale_nl"), "fr-BE": tr("email.editor.locale_fr"), en: tr("email.editor.locale_en") };
  const canEdit = hasPermission(actor, "campaigns.send") && (RECIPIENT_EDIT_STATUSES as readonly string[]).includes(c.status);
  const pages = Math.max(1, Math.ceil(list.total / list.pageSize));
  const base = `/admin/campaigns/${c.id}/recipients`;
  const query = (p: number) => `${base}?page=${p}${status ? `&status=${status}` : ""}${sp.q ? `&q=${encodeURIComponent(sp.q)}` : ""}`;

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">{clab(labels, "recipients_title", { name: c.name })}</h1>
        <Button variant="ghost" asChild>
          <Link href={`/admin/campaigns/${c.id}`}>{clab(labels, "back_to_campaign")}</Link>
        </Button>
      </div>
      <form className="flex flex-wrap items-end gap-3" method="get">
        <div className="grid gap-1">
          <Label htmlFor="recipients-q">{clab(labels, "search")}</Label>
          <Input id="recipients-q" name="q" defaultValue={sp.q ?? ""} />
        </div>
        <div className="grid gap-1">
          <Label htmlFor="recipients-status">{clab(labels, "col_status")}</Label>
          <select id="recipients-status" name="status" defaultValue={status ?? ""} className="h-9 rounded-md border bg-background px-2 text-sm">
            <option value="">{clab(labels, "all_statuses")}</option>
            {RECIPIENT_STATUSES.map((s) => (
              <option key={s} value={s}>
                {clab(labels, `recipient_${s}`)}
              </option>
            ))}
          </select>
        </div>
        <Button type="submit" variant="outline">
          {clab(labels, "filter")}
        </Button>
      </form>
      {list.total === 0 && !status && !sp.q ? (
        <EmptyState title={clab(labels, "recipients_empty")} />
      ) : (
        <RecipientsTable campaignId={c.id} rows={list.items} canEdit={canEdit} localeNames={localeNames} labels={labels} />
      )}
      {pages > 1 ? (
        <nav className="flex items-center gap-2" aria-label={clab(labels, "pagination")}>
          {page > 1 ? (
            <Button variant="outline" size="sm" asChild>
              <Link href={query(page - 1) as never}>{clab(labels, "previous")}</Link>
            </Button>
          ) : null}
          <span className="text-sm">{clab(labels, "page_of", { page, pages })}</span>
          {page < pages ? (
            <Button variant="outline" size="sm" asChild>
              <Link href={query(page + 1) as never}>{clab(labels, "next")}</Link>
            </Button>
          ) : null}
        </nav>
      ) : null}
    </div>
  );
}
