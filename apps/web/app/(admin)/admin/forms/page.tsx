import type { Route } from "next";
import Link from "next/link";
import { cn, EmptyState } from "@beam/ui";
import { FORM_KINDS, type FormKind, type FormStatus } from "@beam/core/forms";
import { hasPermission, requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { listForms } from "@/modules/forms/queries";
import { Segmented, StatusPill, Surface, Toolbar, td, th, type Tone } from "@/modules/platform/ui/admin-kit";
import { Disclosure, Field, fieldClass, rowClass, rowLink, SearchField } from "@/modules/platform/ui/admin-list-kit";
import { FormsHeader } from "./forms-header";

type Search = { q?: string; status?: string; kind?: string };

const STATUSES: readonly FormStatus[] = ["draft", "published", "archived"];
const TONE: Record<FormStatus, Tone> = { draft: "muted", published: "ok", archived: "muted" };
const pick = <T extends string>(list: readonly T[], v: string | undefined): T | undefined => (list.includes(v as T) ? (v as T) : undefined);
const pct = (v: number | null) => (v === null ? "–" : `${Math.round(v * 100)} %`);

/**
 * `/admin/forms` (`forms.write`, forms spec section 5), in the back-office kit (owner review,
 * November 2026): the forms area's header with the Formulieren | Imports tabs, a search with the
 * status tabs and the kind behind "Filters", and every form with its 30-day funnel; a row opens
 * the form.
 */
export default async function FormsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const actor = await requireStaff({ permission: "forms.write" });
  const sp = await searchParams;
  const locale = await adminLocale();
  const tr = translator(locale);
  const t = (k: string) => tr(`forms.list.${k}`);
  const status = pick(STATUSES, sp.status);
  const kind = pick<FormKind>(FORM_KINDS, sp.kind);
  const q = sp.q?.trim() || undefined;
  const rows = await listForms(await getAppDb(), { status, kind, q });
  const href = (patch: Record<string, string | undefined>): Route => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ q, status, kind, ...patch })) if (v) p.set(k, v);
    const s = p.toString();
    return s ? `/admin/forms?${s}` : "/admin/forms";
  };
  const filtered = !!(q || status || kind);

  return (
    <div className="grid gap-4">
      <FormsHeader active="forms" canImports={hasPermission(actor, "forms.publish")} tr={tr} />
      <form data-auto-filter="" method="get" role="search">
        <Toolbar>
          {status ? <input type="hidden" name="status" value={status} /> : null}
          <SearchField label={t("search")} placeholder={t("search_placeholder")} defaultValue={q} />
          <Segmented
            label={t("status")}
            items={[{ key: "all", label: t("all_statuses"), href: href({ status: undefined }), active: !status }, ...STATUSES.map((s) => ({ key: s, label: tr(`forms.status.${s}`), href: href({ status: s }), active: status === s }))]}
          />
          <Disclosure label={t("filters")} count={kind ? 1 : 0} clear={kind ? { href: href({ kind: undefined }), label: t("clear") } : null}>
            <Field label={t("kind")}>
              <select id="forms-kind" name="kind" defaultValue={kind ?? ""} className={fieldClass}>
                <option value="">{t("all_kinds")}</option>
                {FORM_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {tr(`forms.kind.${k}`)}
                  </option>
                ))}
              </select>
            </Field>
          </Disclosure>
        </Toolbar>
      </form>

      {rows.length === 0 ? (
        filtered ? (
          <EmptyState title={t("no_match")} />
        ) : (
          <EmptyState
            title={t("empty")}
            action={
              <div className="flex gap-3 text-[0.8125rem] font-semibold">
                <Link className="hover:underline" href="/admin/forms/new?template=lead&kind=lead">
                  {t("template_lead")}
                </Link>
                <Link className="hover:underline" href="/admin/forms/new?template=assessment&kind=assessment">
                  {t("template_assessment")}
                </Link>
              </div>
            }
          />
        )
      ) : (
        <Surface flush>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[52rem] text-[0.8125rem]" data-testid="forms-list">
              <caption className="sr-only">{t("title")}</caption>
              <thead className="bg-[#faf9f6]">
                <tr className="border-b border-border">
                  <th scope="col" className={th}>{t("name")}</th>
                  <th scope="col" className={cn(th, "w-36")}>{t("kind")}</th>
                  <th scope="col" className={cn(th, "w-44")}>{t("status")}</th>
                  <th scope="col" className={cn(th, "w-28")}>{t("locales")}</th>
                  <th scope="col" className={cn(th, "w-28 text-right")}>{t("started")}</th>
                  <th scope="col" className={cn(th, "w-28 text-right")}>{t("completed")}</th>
                  <th scope="col" className={cn(th, "w-24 text-right")}>{t("rate")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className={rowClass} data-form-id={r.id}>
                    <td className={td}>
                      <span className="grid leading-tight">
                        <Link href={`/admin/forms/${r.id}`} className={cn(rowLink, "font-semibold hover:underline")}>
                          {r.name[locale] || r.slug}
                        </Link>
                        <span className="font-mono text-[0.6875rem] text-muted-foreground">
                          {r.slug}
                          {r.currentVersion ? ` · v${r.currentVersion}` : ""}
                        </span>
                      </span>
                    </td>
                    <td className={td}>{tr(`forms.kind.${r.kind}`)}</td>
                    <td className={td}>
                      <span className="flex flex-wrap gap-1">
                        <StatusPill tone={TONE[r.status]}>{tr(`forms.status.${r.status}`)}</StatusPill>
                        {r.hasDraft && r.status !== "draft" ? <StatusPill tone="gold">{t("draft_badge")}</StatusPill> : null}
                      </span>
                    </td>
                    <td className={cn(td, "text-muted-foreground")}>{r.locales.map((l) => l.slice(0, 2).toUpperCase()).join(" · ")}</td>
                    <td className={cn(td, "text-right tabular-nums")}>{r.started30d}</td>
                    <td className={cn(td, "text-right font-semibold tabular-nums")}>{r.completed30d}</td>
                    <td className={cn(td, "text-right tabular-nums")}>{pct(r.completionRate)}</td>
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
