import Link from "next/link";
import { redirect } from "next/navigation";
import { Alert, AlertDescription, Badge, Button, EmptyState, Input, Label, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@beam/ui";
import { MARKETING_PURPOSES, TEMPLATE_STATUSES, type MarketingPurpose } from "@beam/core/email";
import { hasPermission, requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, softTranslator, translator } from "@/lib/i18n";
import { archiveTemplate, createTemplate, duplicateTemplate } from "@/modules/email/actions";
import { listTemplateModules, listTemplates } from "@/modules/email/queries";

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
 * `/admin/templates` (`email.write`), email spec section 5: tabs Transactional and Marketing with
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

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
      </div>
      {errorText ? (
        <Alert variant="destructive">
          <AlertDescription>{errorText}</AlertDescription>
        </Alert>
      ) : null}
      <nav className="flex gap-2" aria-label={t("tabs")}>
        {(["transactional", "marketing"] as const).map((k) => (
          <Button key={k} variant={k === kind ? "default" : "outline"} asChild>
            <Link href={`/admin/templates?kind=${k}`} aria-current={k === kind ? "page" : undefined}>
              {t(`tab_${k}`)}
            </Link>
          </Button>
        ))}
      </nav>
      <form className="flex flex-wrap items-end gap-3" method="get">
        <input type="hidden" name="kind" value={kind} />
        <div className="grid gap-1">
          <Label htmlFor="templates-q">{t("search")}</Label>
          <Input id="templates-q" name="q" defaultValue={sp.q ?? ""} />
        </div>
        <div className="grid gap-1">
          <Label htmlFor="templates-status">{t("col_status")}</Label>
          <select id="templates-status" name="status" defaultValue={status ?? ""} className="h-9 rounded-md border bg-background px-2 text-sm">
            <option value="">{t("status_active")}</option>
            {TEMPLATE_STATUSES.map((s) => (
              <option key={s} value={s}>
                {t(`status_${s}`)}
              </option>
            ))}
          </select>
        </div>
        {kind === "transactional" ? (
          <div className="grid gap-1">
            <Label htmlFor="templates-module">{t("module")}</Label>
            <select id="templates-module" name="module" defaultValue={sp.module ?? ""} className="h-9 rounded-md border bg-background px-2 text-sm">
              <option value="">{t("all_modules")}</option>
              {modules.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        <Button type="submit" variant="outline">
          {t("filter")}
        </Button>
      </form>
      {kind === "marketing" ? (
        <form action={create} className="flex flex-wrap items-end gap-3 rounded-md border p-4" aria-label={t("new")}>
          <div className="grid gap-1">
            <Label htmlFor="new-template-name">{t("new_name")}</Label>
            <Input id="new-template-name" name="name" required maxLength={160} />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="new-template-purpose">{t("new_purpose")}</Label>
            <select id="new-template-purpose" name="purpose" defaultValue="newsletter" className="h-9 rounded-md border bg-background px-2 text-sm">
              {MARKETING_PURPOSES.map((p) => (
                <option key={p} value={p}>
                  {tr(`email.templates.purpose_${p}`)}
                </option>
              ))}
            </select>
          </div>
          <Button type="submit">{t("new")}</Button>
        </form>
      ) : null}
      {list.items.length === 0 ? (
        <EmptyState title={kind === "marketing" ? t("empty_marketing") : t("empty_transactional")} />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("col_name")}</TableHead>
              <TableHead>{t("col_slug")}</TableHead>
              <TableHead>{t("col_status")}</TableHead>
              <TableHead>{t("col_version")}</TableHead>
              <TableHead>{t("col_locales")}</TableHead>
              <TableHead>{t("col_published")}</TableHead>
              <TableHead>{t("col_actions")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.items.map((r) => (
              <TableRow key={r.id}>
                <TableCell>
                  <Link className="font-medium underline-offset-2 hover:underline" href={`/admin/templates/${r.id}`}>
                    {r.name}
                  </Link>
                  {r.hasDraft ? (
                    <Badge variant="secondary" className="ml-2">
                      {t("draft_pending")}
                    </Badge>
                  ) : null}
                </TableCell>
                <TableCell className="font-mono text-xs">{r.slug}</TableCell>
                <TableCell>
                  <Badge variant={r.status === "published" ? "default" : "outline"}>{t(`status_${r.status}`)}</Badge>
                </TableCell>
                <TableCell className="tabular-nums">{r.currentVersion ? `v${r.currentVersion}` : "—"}</TableCell>
                <TableCell>
                  <div className="flex gap-1">
                    {r.locales.map((l) => (
                      <Badge key={l} variant="outline">
                        {l}
                      </Badge>
                    ))}
                  </div>
                </TableCell>
                <TableCell>{r.lastPublishedAt ? dateFmt.format(r.lastPublishedAt) : "—"}</TableCell>
                <TableCell>
                  <div className="flex flex-wrap gap-2">
                    {r.kind === "marketing" ? (
                      <form action={duplicate}>
                        <input type="hidden" name="templateId" value={r.id} />
                        <input type="hidden" name="name" value={t("copy_of", { name: r.name }).slice(0, 160)} />
                        <Button type="submit" size="sm" variant="outline">
                          {t("duplicate")}
                        </Button>
                      </form>
                    ) : null}
                    {canSend && !r.isSystem && r.status !== "archived" ? (
                      <form action={archive}>
                        <input type="hidden" name="templateId" value={r.id} />
                        <input type="hidden" name="kind" value={kind} />
                        <Button type="submit" size="sm" variant="ghost">
                          {t("archive")}
                        </Button>
                      </form>
                    ) : null}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {pages > 1 ? (
        <nav className="flex items-center gap-2" aria-label={t("pagination")}>
          {page > 1 ? (
            <Button variant="outline" size="sm" asChild>
              <Link href={`/admin/templates?kind=${kind}&page=${page - 1}`}>{t("previous")}</Link>
            </Button>
          ) : null}
          <span className="text-sm">{t("page_of", { page, pages })}</span>
          {page < pages ? (
            <Button variant="outline" size="sm" asChild>
              <Link href={`/admin/templates?kind=${kind}&page=${page + 1}`}>{t("next")}</Link>
            </Button>
          ) : null}
        </nav>
      ) : null}
    </div>
  );
}
