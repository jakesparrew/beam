import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Alert, AlertDescription, Badge, Button, EmptyState, Input, Label, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@beam/ui";
import { CAMPAIGN_STATUSES, type CampaignStatus } from "@beam/core/email";
import { hasPermission, requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, softTranslator, translator } from "@/lib/i18n";
import { duplicateCampaign } from "@/modules/email/actions";
import { listCampaigns } from "@/modules/email/queries";

type Search = { status?: string; q?: string; page?: string; error?: string };

function field(form: FormData, name: string, fallback = ""): string {
  const v = form.get(name);
  return typeof v === "string" ? v : fallback;
}

async function duplicate(form: FormData) {
  "use server";
  const result = await duplicateCampaign({ campaignId: field(form, "campaignId") });
  if (!result.ok) redirect(`/admin/campaigns?error=${encodeURIComponent(result.error.message)}` as never);
  redirect(`/admin/campaigns/${result.data.campaignId}` as never);
}

const pct = (v: number | null) => (v === null ? "—" : `${(v * 100).toFixed(1)} %`);

/**
 * `/admin/campaigns` (`email.write`, or `reports.read` read-only), email spec section 5: name,
 * status, purpose, segment, scheduled or sent date, recipients, open and click rate; new campaign,
 * status filter, search and duplicate.
 */
export default async function CampaignsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const actor = await requireStaff();
  const canWrite = hasPermission(actor, "email.write");
  if (!canWrite && !hasPermission(actor, "reports.read")) notFound();
  const sp = await searchParams;
  const status = (CAMPAIGN_STATUSES as readonly string[]).includes(sp.status ?? "") ? (sp.status as CampaignStatus) : undefined;
  const page = Math.max(1, Number(sp.page) || 1);
  const locale = await adminLocale();
  const tr = translator(locale);
  const t = (k: string, p?: Record<string, string | number>) => tr(`email.campaigns.${k}`, p);
  const soft = softTranslator(locale);
  const list = await listCampaigns(await getAppDb(), { ...(status ? { status } : {}), ...(sp.q ? { q: sp.q } : {}), page });
  const dateFmt = new Intl.DateTimeFormat(locale, { timeZone: "Europe/Brussels", dateStyle: "medium", timeStyle: "short" });
  const pages = Math.max(1, Math.ceil(list.total / list.pageSize));
  const errorKey = sp.error ? `email.campaigns.errors.${sp.error.replace(/[^a-z_]/g, "")}` : null;
  const errorText = errorKey ? (soft(errorKey) === errorKey ? t("errors.generic") : soft(errorKey)) : null;
  const query = (p: number) => `/admin/campaigns?page=${p}${status ? `&status=${status}` : ""}${sp.q ? `&q=${encodeURIComponent(sp.q)}` : ""}`;

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        {canWrite ? (
          <Button asChild>
            <Link href="/admin/campaigns/new" data-testid="campaign-new">
              {t("new")}
            </Link>
          </Button>
        ) : null}
      </div>
      {errorText ? (
        <Alert variant="destructive">
          <AlertDescription>{errorText}</AlertDescription>
        </Alert>
      ) : null}
      <form className="flex flex-wrap items-end gap-3" method="get">
        <div className="grid gap-1">
          <Label htmlFor="campaigns-q">{t("search")}</Label>
          <Input id="campaigns-q" name="q" defaultValue={sp.q ?? ""} />
        </div>
        <div className="grid gap-1">
          <Label htmlFor="campaigns-status">{t("col_status")}</Label>
          <select id="campaigns-status" name="status" defaultValue={status ?? ""} className="h-9 rounded-md border bg-background px-2 text-sm">
            <option value="">{t("all_statuses")}</option>
            {CAMPAIGN_STATUSES.map((s) => (
              <option key={s} value={s}>
                {t(`status_${s}`)}
              </option>
            ))}
          </select>
        </div>
        <Button type="submit" variant="outline">
          {t("filter")}
        </Button>
      </form>
      {list.items.length === 0 ? (
        <EmptyState
          title={t("empty")}
          action={
            canWrite ? (
              <Button asChild>
                <Link href="/admin/campaigns/new">{t("new")}</Link>
              </Button>
            ) : undefined
          }
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("col_name")}</TableHead>
              <TableHead>{t("col_status")}</TableHead>
              <TableHead>{t("col_purpose")}</TableHead>
              <TableHead>{t("col_segment")}</TableHead>
              <TableHead>{t("col_date")}</TableHead>
              <TableHead className="text-right">{t("col_recipients")}</TableHead>
              <TableHead className="text-right">{t("col_open_rate")}</TableHead>
              <TableHead className="text-right">{t("col_click_rate")}</TableHead>
              {canWrite ? <TableHead>{t("col_actions")}</TableHead> : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.items.map((c) => {
              const at = c.finishedAt ?? c.startedAt ?? c.scheduledAt;
              return (
                <TableRow key={c.id} data-campaign-id={c.id}>
                  <TableCell>
                    <Link className="font-medium underline-offset-2 hover:underline" href={`/admin/campaigns/${c.id}`}>
                      {c.name}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <Badge variant={c.status === "sent" ? "default" : c.status === "draft" ? "outline" : "secondary"}>{t(`status_${c.status}`)}</Badge>
                  </TableCell>
                  <TableCell>{t(`purpose_${c.purpose}`)}</TableCell>
                  <TableCell>{c.segmentName ?? "—"}</TableCell>
                  <TableCell>{at ? dateFmt.format(at) : "—"}</TableCell>
                  <TableCell className="text-right tabular-nums">{c.recipients}</TableCell>
                  <TableCell className="text-right tabular-nums">{pct(c.openRate)}</TableCell>
                  <TableCell className="text-right tabular-nums">{pct(c.clickRate)}</TableCell>
                  {canWrite ? (
                    <TableCell>
                      <form action={duplicate}>
                        <input type="hidden" name="campaignId" value={c.id} />
                        <Button type="submit" size="sm" variant="outline">
                          {t("duplicate")}
                        </Button>
                      </form>
                    </TableCell>
                  ) : null}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
      {pages > 1 ? (
        <nav className="flex items-center gap-2" aria-label={t("pagination")}>
          {page > 1 ? (
            <Button variant="outline" size="sm" asChild>
              <Link href={query(page - 1) as never}>{t("previous")}</Link>
            </Button>
          ) : null}
          <span className="text-sm">{t("page_of", { page, pages })}</span>
          {page < pages ? (
            <Button variant="outline" size="sm" asChild>
              <Link href={query(page + 1) as never}>{t("next")}</Link>
            </Button>
          ) : null}
        </nav>
      ) : null}
    </div>
  );
}
