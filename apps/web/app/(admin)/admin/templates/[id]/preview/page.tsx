import Link from "next/link";
import { notFound } from "next/navigation";
import { Button, Input, Label } from "@beam/ui";
import { isLocale, LOCALES, type Locale } from "@beam/core/i18n";
import { hasPermission, requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { searchPersons } from "@/modules/crm/api";
import { catalogueSection, getPreview } from "@/modules/email/queries";
import { PreviewFrame } from "@/modules/email/ui/editor/PreviewFrame";

type Search = { locale?: string; as?: string; personId?: string; outcome?: string; use?: string; version?: string; q?: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAMPLES = ["lead", "customer", "member"] as const;

/**
 * `/admin/templates/[id]/preview` (`email.write`; a real contact also `persons.read`), email spec
 * section 5: desktop and mobile frames, HTML and plain text, subject and preheader, size warning,
 * "Preview as" a person (search), Lead, Customer, Member and an assessment outcome; locale switch;
 * `?version=` previews an earlier version read-only.
 */
export default async function TemplatePreviewPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Search> }) {
  const actor = await requireStaff({ permission: "email.write" });
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const sp = await searchParams;
  const adminLoc = await adminLocale();
  const tr = translator(adminLoc);
  const t = (k: string, p?: Record<string, string | number>) => tr(`email.preview.${k}`, p);
  const db = await getAppDb();
  const canReadPersons = hasPermission(actor, "persons.read");
  const locale: Locale = isLocale(sp.locale) ? sp.locale : "nl-BE";
  const use = sp.use === "current" ? "current" : "draft";
  const sample = (SAMPLES as readonly string[]).includes(sp.as ?? "") ? (sp.as as (typeof SAMPLES)[number]) : null;
  const personId = sp.as === "person" && canReadPersons && sp.personId && UUID.test(sp.personId) ? sp.personId : null;
  const versionId = sp.version && UUID.test(sp.version) ? sp.version : undefined;
  const outcome = sp.outcome?.trim().slice(0, 80) || undefined;
  const as = personId ? { personId } : sample ? { sample, ...(outcome ? { assessmentOutcome: outcome } : {}) } : null;
  const preview = as ? await getPreview(db, { templateId: id, use, locale, as }, { canReadPersons, ...(versionId ? { versionId } : {}) }) : null;
  const matches = canReadPersons && sp.q && sp.q.trim().length >= 2 ? await searchPersons(db, { q: sp.q.trim(), limit: 10 }) : [];
  const labels = catalogueSection(adminLoc, "email.editor");
  const localeNames: Record<Locale, string> = { "nl-BE": tr("email.editor.locale_nl"), "fr-BE": tr("email.editor.locale_fr"), en: tr("email.editor.locale_en") };
  const base = `/admin/templates/${id}/preview`;
  const query = (patch: Partial<Search>) => {
    const next: Record<string, string> = {};
    const merged = { locale, use, ...(versionId ? { version: versionId } : {}), ...(sample ? { as: sample } : {}), ...(personId ? { as: "person", personId } : {}), ...(outcome ? { outcome } : {}), ...patch };
    for (const [k, v] of Object.entries(merged)) if (v) next[k] = String(v);
    return `${base}?${new URLSearchParams(next).toString()}`;
  };

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <Button variant="outline" asChild>
          <Link href={`/admin/templates/${id}`}>{t("back")}</Link>
        </Button>
      </div>
      {versionId ? <p className="text-sm text-muted-foreground">{t("version_readonly")}</p> : null}
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label={t("locale")}>
        {LOCALES.map((l) => (
          <Button key={l} size="sm" variant={l === locale ? "default" : "outline"} asChild>
            <Link href={query({ locale: l }) as never} aria-current={l === locale ? "true" : undefined}>
              {localeNames[l]}
            </Link>
          </Button>
        ))}
        {versionId ? null : (
          <>
            <Button size="sm" variant={use === "draft" ? "default" : "outline"} asChild>
              <Link href={query({ use: "draft" }) as never}>{t("use_draft")}</Link>
            </Button>
            <Button size="sm" variant={use === "current" ? "default" : "outline"} asChild>
              <Link href={query({ use: "current" }) as never}>{t("use_current")}</Link>
            </Button>
          </>
        )}
      </div>
      <div className="grid gap-3 rounded-md border p-4">
        <h2 className="text-base font-semibold">{t("as")}</h2>
        <div className="flex flex-wrap gap-2">
          {SAMPLES.map((s) => (
            <Button key={s} size="sm" variant={sample === s ? "default" : "outline"} asChild>
              <Link href={query({ as: s, personId: "" }) as never} data-persona={s}>
                {t(`sample_${s}`)}
              </Link>
            </Button>
          ))}
        </div>
        <form method="get" className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="locale" value={locale} />
          <input type="hidden" name="use" value={use} />
          <input type="hidden" name="as" value={sample ?? "lead"} />
          {versionId ? <input type="hidden" name="version" value={versionId} /> : null}
          <div className="grid gap-1">
            <Label htmlFor="preview-outcome">{t("outcome")}</Label>
            <Input id="preview-outcome" name="outcome" defaultValue={outcome ?? ""} />
          </div>
          <Button type="submit" size="sm" variant="outline">
            {t("apply")}
          </Button>
        </form>
        {canReadPersons ? (
          <form method="get" className="flex flex-wrap items-end gap-2">
            <input type="hidden" name="locale" value={locale} />
            <input type="hidden" name="use" value={use} />
            {versionId ? <input type="hidden" name="version" value={versionId} /> : null}
            <div className="grid gap-1">
              <Label htmlFor="preview-person">{t("person_search")}</Label>
              <Input id="preview-person" name="q" defaultValue={sp.q ?? ""} />
            </div>
            <Button type="submit" size="sm" variant="outline">
              {t("search")}
            </Button>
          </form>
        ) : null}
        {matches.length ? (
          <ul className="grid gap-1 text-sm">
            {matches.map((m) => (
              <li key={m.personId}>
                <Link className="underline-offset-2 hover:underline" href={query({ as: "person", personId: m.personId }) as never}>
                  {m.name} · {m.customerNumber}
                </Link>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      <PreviewFrame preview={preview} labels={labels} emptyText={t("empty")} />
    </div>
  );
}
