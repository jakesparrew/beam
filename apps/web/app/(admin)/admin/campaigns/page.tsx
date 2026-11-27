import type { Route } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { cn, EmptyState } from "@beam/ui";
import { CAMPAIGN_STATUSES, type CampaignStatus } from "@beam/core/email";
import { hasPermission, requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, softTranslator, translator } from "@/lib/i18n";
import { duplicateCampaign } from "@/modules/email/actions";
import { listCampaigns } from "@/modules/email/queries";
import { SecondaryAction, Segmented, StatusPill, Surface, Toolbar, td, th } from "@/modules/platform/ui/admin-kit";
import { aboveRow, Disclosure, Field, fieldClass, Notice, rowClass, rowLink, SearchField } from "@/modules/platform/ui/admin-list-kit";
import { CAMPAIGN_TONE, EmailHeader } from "./email-header";

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

const pct = (v: number | null) => (v === null ? "–" : `${(v * 100).toFixed(1)} %`);
/** The three states the team follows as tabs; the rarer ones sit behind "Filters". */
const TABS = ["draft", "scheduled", "sent"] as const;

/**
 * `/admin/campaigns` (`email.write`, or `reports.read` read-only), email spec section 5, in the
 * back-office kit (owner review, November 2026): the email area's header with the tabs
 * Nieuwsbrieven | Statistieken | Verzonden berichten, a search with the status tabs (the rarer
 * statuses behind "Filters"), and a table whose rows open the campaign: name with category and
 * segment, status pill, scheduled or sent date, audience, open and click rate; duplicate per row.
 */
export default async function CampaignsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const actor = await requireStaff();
  const canWrite = hasPermission(actor, "email.write");
  if (!canWrite && !hasPermission(actor, "reports.read")) notFound();
  const sp = await searchParams;
  const status = (CAMPAIGN_STATUSES as readonly string[]).includes(sp.status ?? "") ? (sp.status as CampaignStatus) : undefined;
  const q = sp.q?.trim().slice(0, 100) || undefined;
  const page = Math.max(1, Number(sp.page) || 1);
  const locale = await adminLocale();
  const tr = translator(locale);
  const t = (k: string, p?: Record<string, string | number>) => tr(`email.campaigns.${k}`, p);
  const soft = softTranslator(locale);
  const list = await listCampaigns(await getAppDb(), { ...(status ? { status } : {}), ...(q ? { q } : {}), page });
  const dateFmt = new Intl.DateTimeFormat(locale, { timeZone: "Europe/Brussels", dateStyle: "medium", timeStyle: "short" });
  const pages = Math.max(1, Math.ceil(list.total / list.pageSize));
  const errorKey = sp.error ? `email.campaigns.errors.${sp.error.replace(/[^a-z_]/g, "")}` : null;
  const errorText = errorKey ? (soft(errorKey) === errorKey ? t("errors.generic") : soft(errorKey)) : null;
  const href = (patch: Record<string, string | undefined>): Route => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ q, status, ...patch })) if (v) p.set(k, v);
    const s = p.toString();
    return s ? `/admin/campaigns?${s}` : "/admin/campaigns";
  };
  const rare = status && !(TABS as readonly string[]).includes(status) ? status : undefined;

  return (
    <div className="grid gap-4">
      <EmailHeader active="campaigns" canWrite={canWrite} tr={tr} />
      {errorText ? <Notice tone="bad">{errorText}</Notice> : null}

      <form data-auto-filter="" method="get" role="search">
        <Toolbar>
          <SearchField label={t("search")} placeholder={t("search_placeholder")} defaultValue={q} />
          <Segmented
            label={t("col_status")}
            items={[
              { key: "all", label: t("all_statuses"), href: href({ status: undefined }), active: !status },
              ...TABS.map((s) => ({ key: s, label: t(`status_${s}`), href: href({ status: s }), active: status === s })),
            ]}
          />
          <Disclosure label={t("filter")} count={rare ? 1 : 0} clear={rare ? { href: href({ status: undefined }), label: t("clear") } : null}>
            <Field label={t("col_status")}>
              <select id="campaigns-status" name="status" defaultValue={status ?? ""} className={fieldClass}>
                <option value="">{t("all_statuses")}</option>
                {CAMPAIGN_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {t(`status_${s}`)}
                  </option>
                ))}
              </select>
            </Field>
          </Disclosure>
        </Toolbar>
      </form>

      {list.items.length === 0 ? (
        <EmptyState title={q || status ? t("empty_filtered") : t("empty")} />
      ) : (
        <Surface flush data-testid="campaigns-list">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[52rem] text-[0.8125rem]">
              <caption className="sr-only">{tr("email.nav.campaigns")}</caption>
              <thead className="bg-[#faf9f6]">
                <tr className="border-b border-border">
                  <th scope="col" className={th}>{t("col_name")}</th>
                  <th scope="col" className={cn(th, "w-40")}>{t("col_status")}</th>
                  <th scope="col" className={cn(th, "w-44")}>{t("col_date")}</th>
                  <th scope="col" className={cn(th, "w-28 text-right")}>{t("col_recipients")}</th>
                  <th scope="col" className={cn(th, "w-28 text-right")}>{t("col_open_rate")}</th>
                  <th scope="col" className={cn(th, "w-24 text-right")}>{t("col_click_rate")}</th>
                  {canWrite ? (
                    <th scope="col" className={cn(th, "w-28")}>
                      <span className="sr-only">{t("col_actions")}</span>
                    </th>
                  ) : null}
                </tr>
              </thead>
              <tbody>
                {list.items.map((c) => {
                  const at = c.finishedAt ?? c.startedAt ?? c.scheduledAt;
                  return (
                    <tr key={c.id} data-campaign-id={c.id} className={rowClass}>
                      <td className={td}>
                        <span className="grid leading-tight">
                          <Link href={`/admin/campaigns/${c.id}`} className={cn(rowLink, "font-semibold hover:underline")}>
                            {c.name}
                          </Link>
                          <span className="text-[0.75rem] text-muted-foreground">
                            {t(`purpose_${c.purpose}`)}
                            {c.segmentName ? ` · ${c.segmentName}` : ""}
                          </span>
                        </span>
                      </td>
                      <td className={td}>
                        <StatusPill tone={CAMPAIGN_TONE[c.status]}>{t(`status_${c.status}`)}</StatusPill>
                      </td>
                      <td className={cn(td, "whitespace-nowrap")}>{at ? dateFmt.format(at) : <span className="text-muted-foreground">–</span>}</td>
                      <td className={cn(td, "text-right font-semibold tabular-nums")}>{c.recipients}</td>
                      <td className={cn(td, "text-right tabular-nums")}>{pct(c.openRate)}</td>
                      <td className={cn(td, "text-right tabular-nums")}>{pct(c.clickRate)}</td>
                      {canWrite ? (
                        <td className={cn(td, "text-right")}>
                          <form action={duplicate} className={aboveRow}>
                            <input type="hidden" name="campaignId" value={c.id} />
                            <button type="submit" className="text-[0.75rem] font-semibold text-muted-foreground hover:text-foreground">
                              {t("duplicate")}
                            </button>
                          </form>
                        </td>
                      ) : null}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Surface>
      )}
      {pages > 1 ? (
        <nav className="flex items-center gap-2" aria-label={t("pagination")}>
          {page > 1 ? <SecondaryAction href={href({ page: String(page - 1) })}>{t("previous")}</SecondaryAction> : null}
          <span className="text-[0.8125rem] text-muted-foreground">{t("page_of", { page, pages })}</span>
          {page < pages ? <SecondaryAction href={href({ page: String(page + 1) })}>{t("next")}</SecondaryAction> : null}
        </nav>
      ) : null}
    </div>
  );
}
