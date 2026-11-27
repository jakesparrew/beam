import type { Route } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { cn, EmptyState } from "@beam/ui";
import { MARKETING_PURPOSES, TEMPLATE_STATUSES, type MarketingPurpose } from "@beam/core/email";
import { hasPermission, requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, softTranslator, translator } from "@/lib/i18n";
import { archiveTemplate, createTemplate, duplicateTemplate } from "@/modules/email/actions";
import { listTemplateModules, listTemplates } from "@/modules/email/queries";
import { PageHeader, SecondaryAction, Segmented, StatusPill, Surface, Toolbar, td, th } from "@/modules/platform/ui/admin-kit";
import { aboveRow, Disclosure, Field, fieldClass, Notice, rowClass, rowLink, SearchField } from "@/modules/platform/ui/admin-list-kit";

type Search = { kind?: string; status?: string; q?: string; module?: string; page?: string; error?: string };

const back = (kind: string, error?: string) => `/admin/templates?kind=${kind}${error ? `&error=${encodeURIComponent(error)}` : ""}`;

/** A text field of a submitted form (files and missing fields read as the fallback). */
function field(form: FormData, name: string, fallback = ""): string {
  const v = form.get(name);
  return typeof v === "string" ? v : fallback;
}

async function create(form: FormData) {
  "use server";
  const purpose = field(form, "purpose", "newsletter") as MarketingPurpose;
  const result = await createTemplate({ name: field(form, "name", ""), kind: "marketing", purpose });
  if (!result.ok) redirect(back("marketing", result.error.message) as never);
  redirect(`/admin/templates/${result.data.templateId}` as never);
}

async function duplicate(form: FormData) {
  "use server";
  const result = await duplicateTemplate({ templateId: field(form, "templateId"), name: field(form, "name", "") });
  if (!result.ok) redirect(back("marketing", result.error.message) as never);
  redirect(`/admin/templates/${result.data.templateId}` as never);
}

async function archive(form: FormData) {
  "use server";
  const kind = field(form, "kind", "marketing");
  const result = await archiveTemplate({ templateId: field(form, "templateId") });
  redirect(back(kind, result.ok ? undefined : result.error.message) as never);
}

/**
 * `/admin/templates` (`email.write`), email spec section 5, in the back-office kit (owner review,
 * November 2026): a search, tabs Marketing and Transactional (status and module behind "Filters"), with
 * name, slug, status, current version, locale badges and last published; new marketing template,
 * duplicate and archive (`email.send`); filter by owning module on the transactional tab.
 */
export default async function TemplatesPage({ searchParams }: { searchParams: Promise<Search> }) {
  const actor = await requireStaff({ permission: "email.write" });
  const sp = await searchParams;
  const kind = sp.kind === "transactional" ? "transactional" : "marketing";
  const status = (TEMPLATE_STATUSES as readonly string[]).includes(sp.status ?? "") ? (sp.status as (typeof TEMPLATE_STATUSES)[number]) : undefined;
  const locale = await adminLocale();
  const tr = translator(locale);
  const t = (k: string, p?: Record<string, string | number>) => tr(`email.templates.${k}`, p);
  const db = await getAppDb();
  const page = Math.max(1, Number(sp.page) || 1);
  const [list, modules] = await Promise.all([
    listTemplates(db, { kind, ...(status ? { status } : {}), ...(sp.q ? { q: sp.q } : {}), ...(kind === "transactional" && sp.module ? { module: sp.module } : {}), page }),
    kind === "transactional" ? listTemplateModules(db) : Promise.resolve([] as string[]),
  ]);
  const canSend = hasPermission(actor, "email.send");
  const dateFmt = new Intl.DateTimeFormat(locale, { timeZone: "Europe/Brussels", dateStyle: "medium", timeStyle: "short" });
  const pages = Math.max(1, Math.ceil(list.total / list.pageSize));
  const soft = softTranslator(locale);
  const errorKey = sp.error ? `email.templates.errors.${sp.error.replace(/[^a-z_]/g, "")}` : null;
  const errorText = errorKey ? (soft(errorKey) === errorKey ? t("errors.generic") : soft(errorKey)) : null;

  const href = (patch: Record<string, string | undefined>): Route => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ kind, q: sp.q || undefined, status, module: kind === "transactional" ? sp.module || undefined : undefined, ...patch })) if (v) p.set(k, v);
    return `/admin/templates?${p.toString()}` as Route;
  };
  const moreFilters = [status, kind === "transactional" ? sp.module : undefined].filter(Boolean).length;

  return (
    <div className="grid gap-4">
      <PageHeader
        title={t("title")}
        description={t("subtitle")}
        actions={
          kind === "marketing" ? (
            <form action={create} className="flex flex-wrap items-center gap-2" aria-label={t("new")}>
              <label className="sr-only" htmlFor="new-template-name">
                {t("new_name")}
              </label>
              <input id="new-template-name" name="name" required maxLength={160} placeholder={t("new_name_placeholder")} className="h-9 w-56 rounded-lg border border-input bg-card px-3 text-[0.8125rem]" />
              <label className="sr-only" htmlFor="new-template-purpose">
                {t("new_purpose")}
              </label>
              <select id="new-template-purpose" name="purpose" defaultValue="newsletter" className="h-9 rounded-lg border border-input bg-card px-2.5 text-[0.8125rem]">
                {MARKETING_PURPOSES.map((p) => (
                  <option key={p} value={p}>
                    {tr(`email.templates.purpose_${p}`)}
                  </option>
                ))}
              </select>
              <button type="submit" className="inline-flex h-9 items-center rounded-lg bg-primary px-3.5 text-[0.8125rem] font-semibold text-primary-foreground hover:opacity-90">
                + {t("new")}
              </button>
            </form>
          ) : null
        }
      />
      {errorText ? <Notice tone="bad">{errorText}</Notice> : null}
      <form data-auto-filter="" method="get" role="search">
        <Toolbar>
          <input type="hidden" name="kind" value={kind} />
          <SearchField label={t("search")} placeholder={t("search")} defaultValue={sp.q} />
          <Segmented label={t("tabs")} items={(["marketing", "transactional"] as const).map((k) => ({ key: k, label: t(`tab_${k}`), href: `/admin/templates?kind=${k}` as Route, active: k === kind }))} />
          <Disclosure label={t("filter")} count={moreFilters} clear={moreFilters ? { href: href({ status: undefined, module: undefined }), label: t("clear") } : null}>
            <Field label={t("col_status")}>
              <select id="templates-status" name="status" defaultValue={status ?? ""} className={fieldClass}>
                <option value="">{t("status_active")}</option>
                {TEMPLATE_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {t(`status_${s}`)}
                  </option>
                ))}
              </select>
            </Field>
            {kind === "transactional" ? (
              <Field label={t("module")}>
                <select id="templates-module" name="module" defaultValue={sp.module ?? ""} className={fieldClass}>
                  <option value="">{t("all_modules")}</option>
                  {modules.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </Field>
            ) : null}
          </Disclosure>
        </Toolbar>
      </form>
      {list.items.length === 0 ? (
        <EmptyState title={kind === "marketing" ? t("empty_marketing") : t("empty_transactional")} />
      ) : (
        <Surface flush>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[52rem] text-[0.8125rem]">
              <caption className="sr-only">{t("title")}</caption>
              <thead className="bg-[#faf9f6]">
                <tr className="border-b border-border">
                  <th scope="col" className={th}>{t("col_name")}</th>
                  <th scope="col" className={cn(th, "w-56")}>{t("col_status")}</th>
                  <th scope="col" className={cn(th, "w-28 text-right")}>{t("col_version")}</th>
                  <th scope="col" className={cn(th, "w-32")}>{t("col_locales")}</th>
                  <th scope="col" className={cn(th, "w-44")}>{t("col_published")}</th>
                  <th scope="col" className={cn(th, "w-40")}>
                    <span className="sr-only">{t("col_actions")}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {list.items.map((r) => (
                  <tr key={r.id} className={rowClass}>
                    <td className={td}>
                      <span className="grid leading-tight">
                        <Link className={cn(rowLink, "font-semibold hover:underline")} href={`/admin/templates/${r.id}`}>
                          {r.name}
                        </Link>
                        <span className="font-mono text-[0.6875rem] text-muted-foreground">{r.slug}</span>
                      </span>
                    </td>
                    <td className={td}>
                      <span className="flex flex-wrap gap-1">
                        <StatusPill tone={r.status === "published" ? "ok" : "muted"}>{t(`status_${r.status}`)}</StatusPill>
                        {r.hasDraft ? <StatusPill tone="gold">{t("draft_pending")}</StatusPill> : null}
                      </span>
                    </td>
                    <td className={cn(td, "text-right tabular-nums")}>{r.currentVersion ? `v${r.currentVersion}` : "–"}</td>
                    <td className={cn(td, "text-muted-foreground")}>{r.locales.map((l) => l.slice(0, 2).toUpperCase()).join(" · ")}</td>
                    <td className={cn(td, "whitespace-nowrap text-muted-foreground")}>{r.lastPublishedAt ? dateFmt.format(r.lastPublishedAt) : "–"}</td>
                    <td className={cn(td, "text-right")}>
                      <span className={cn(aboveRow, "inline-flex gap-3 text-[0.75rem] font-semibold text-muted-foreground")}>
                        {r.kind === "marketing" ? (
                          <form action={duplicate}>
                            <input type="hidden" name="templateId" value={r.id} />
                            <input type="hidden" name="name" value={t("copy_of", { name: r.name }).slice(0, 160)} />
                            <button type="submit" className="hover:text-foreground">
                              {t("duplicate")}
                            </button>
                          </form>
                        ) : null}
                        {canSend && !r.isSystem && r.status !== "archived" ? (
                          <form action={archive}>
                            <input type="hidden" name="templateId" value={r.id} />
                            <input type="hidden" name="kind" value={kind} />
                            <button type="submit" className="hover:text-foreground">
                              {t("archive")}
                            </button>
                          </form>
                        ) : null}
                      </span>
                    </td>
                  </tr>
                ))}
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
