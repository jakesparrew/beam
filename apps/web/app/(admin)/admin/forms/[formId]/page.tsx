import Link from "next/link";
import { notFound } from "next/navigation";
import { Alert, AlertDescription, AlertTitle, Badge, buttonVariants, Card, CardContent, CardHeader, CardTitle } from "@beam/ui";
import { SYSTEM_FORM_SLUGS } from "@beam/core/forms";
import { URL_SEGMENT } from "@beam/core/i18n";
import { hasPermission, requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { getForm, screenLabels } from "@/modules/forms/queries";
import { appOrigin, hostedFormUrl } from "@/modules/forms/service/tokens";
import { CopyButton, FormActions } from "@/modules/forms/ui/admin/form-list";

/**
 * `/admin/forms/[formId]` (`forms.write`): status, versions, hosted URL, embed snippet, 7-day
 * funnel, CTA warnings, and links to the builder, scoring, preview, versions, tracked links,
 * submissions (shown with `persons.read`, the second permission of that page) and the report.
 */
export default async function FormOverviewPage({ params }: { params: Promise<{ formId: string }> }) {
  const actor = await requireStaff({ permission: "forms.write" });
  const { formId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(formId)) notFound();
  const locale = await adminLocale();
  const tr = translator(locale);
  const o = (k: string, p?: Record<string, string | number>) => tr(`forms.overview.${k}`, p);
  const form = await getForm(await getAppDb(), formId);
  if (!form) notFound();
  const labels = screenLabels(locale, ["overview", "builder", "links"]);
  const servedLocale = form.current?.locales[0] ?? form.draft?.locales[0] ?? "nl-BE";
  const url = hostedFormUrl(form.slug, servedLocale);
  const snippet = `<div data-beam-form="${form.slug}" data-locale="${URL_SEGMENT[servedLocale]}"></div>\n<script src="${appOrigin()}/api/public/forms/embed.js" async></script>`;
  const isSystem = (SYSTEM_FORM_SLUGS as readonly string[]).includes(form.slug);
  const f = form.funnel7d;

  return (
    <div className="grid gap-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="grid gap-1">
          <h1 className="text-2xl font-semibold">{form.name[locale] || form.slug}</h1>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <code>{form.slug}</code>
            <Badge variant={form.status === "published" ? "success" : "secondary"}>{tr(`forms.status.${form.status}`)}</Badge>
            {form.current ? <span>{o("current_version", { n: form.current.version })}</span> : null}
            {form.draft ? <Badge variant="warning">{o("draft_badge", { n: form.draft.version })}</Badge> : null}
          </div>
        </div>
        <nav className="flex flex-wrap gap-2" aria-label={o("sections")}>
          <Link className={buttonVariants({ variant: "outline" })} href={`/admin/forms/${form.id}/build`}>
            {o("nav_build")}
          </Link>
          <Link className={buttonVariants({ variant: "outline" })} href={`/admin/forms/${form.id}/scoring`}>
            {o("nav_scoring")}
          </Link>
          <Link className={buttonVariants({ variant: "outline" })} href={`/admin/forms/${form.id}/preview`}>
            {o("nav_preview")}
          </Link>
          <Link className={buttonVariants({ variant: "outline" })} href={`/admin/forms/${form.id}/versions`}>
            {o("nav_versions")}
          </Link>
          <Link className={buttonVariants({ variant: "outline" })} href={`/admin/forms/${form.id}/links`}>
            {o("nav_links", { n: form.linkCount })}
          </Link>
          {hasPermission(actor, "persons.read") ? (
            <Link className={buttonVariants({ variant: "outline" })} href={`/admin/forms/${form.id}/submissions`}>
              {o("nav_submissions")}
            </Link>
          ) : null}
          <Link className={buttonVariants({ variant: "outline" })} href={`/admin/forms/${form.id}/report`}>
            {o("nav_report")}
          </Link>
        </nav>
      </header>

      {form.status === "archived" ? (
        <Alert>
          <AlertTitle>{o("archived_title")}</AlertTitle>
          <AlertDescription>{o("archived_body")}</AlertDescription>
        </Alert>
      ) : null}
      {form.ctaWarnings.length ? (
        <Alert variant="destructive" data-cta-warnings={form.ctaWarnings.length}>
          <AlertTitle>{o("cta_warnings", { n: form.ctaWarnings.length })}</AlertTitle>
          <AlertDescription>
            <ul className="grid gap-1">
              {form.ctaWarnings.map((w) => (
                <li key={`${w.endingKey}:${w.ctaKey}`}>
                  <Link className="underline" href={`/admin/forms/${form.id}/build#ending-${w.endingKey}`}>
                    {o("cta_warning_item", { ending: w.endingKey, cta: w.ctaKey })}
                  </Link>{" "}
                  ({tr(`forms.builder.cta_warning.${w.reason}`)})
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}

      <FormActions
        formId={form.id}
        slug={form.slug}
        status={form.status}
        isSystem={isSystem}
        everPublished={form.everPublished}
        hasDraft={!!form.draft}
        currentVersion={form.current?.version ?? null}
        canPublish={hasPermission(actor, "forms.publish")}
        labels={labels}
        name={form.name}
      />

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{o("share")}</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3 text-sm">
            <div className="grid gap-1">
              <span className="font-medium">{o("hosted_url")}</span>
              <div className="flex items-center gap-2">
                <code className="truncate">{url}</code>
                <CopyButton text={url} labels={labels} />
              </div>
            </div>
            <div className="grid gap-1">
              <span className="font-medium">{o("embed")}</span>
              <pre className="overflow-x-auto rounded bg-muted p-2 text-xs">{snippet}</pre>
              <div>
                <CopyButton text={snippet} labels={labels} />
              </div>
            </div>
            {form.importSource ? (
              <p>
                {o("import_source", { name: form.importSource.name, provider: form.importSource.provider })}
                {form.importSource.isActive ? "" : ` (${o("inactive")})`}
              </p>
            ) : null}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>{o("funnel_7d")}</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-5 gap-2 text-center text-sm">
              {(["views", "started", "engaged", "completed", "abandoned"] as const).map((k) => (
                <div key={k} className="grid gap-1">
                  <dt className="text-muted-foreground">{o(`funnel_${k}`)}</dt>
                  <dd className="text-xl font-semibold">{f[k]}</dd>
                </div>
              ))}
            </dl>
          </CardContent>
        </Card>
      </div>
      {form.description ? <p className="text-sm text-muted-foreground">{form.description}</p> : null}
    </div>
  );
}
