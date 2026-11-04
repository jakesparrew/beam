/**
 * Read-only summary of `settings.site` and `settings.company` (site spec section 5
 * `/admin/site/settings`): canonical origin, analytics, GA id, default sharing image, social links,
 * brand voice, R3 ad ids, and the company identification shown in the footer, with "Edit in
 * settings" links to platform's settings pages (`settings.write`). A server component.
 */
import NextLink from "next/link";
import type { Route } from "next";
import { Alert, AlertDescription, buttonVariants } from "@beam/ui";
import type { SiteSettingsSummary } from "../../server/settings";
import type { SiteAdminLabels } from "../../queries/admin";

function Row({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="grid gap-1 border-b py-2 sm:grid-cols-[16rem_1fr]">
      <dt className="text-sm font-medium">{label}</dt>
      <dd className="text-sm break-words whitespace-pre-wrap">{value || "—"}</dd>
    </div>
  );
}

export function SettingsSummary({ summary, L, canEditSettings }: { summary: SiteSettingsSummary; L: SiteAdminLabels; canEditSettings: boolean }) {
  const s = summary.site;
  const c = summary.company;
  const notSet = L["settings.notSet"];
  const social = Object.entries(s.social_links)
    .filter(([, v]) => !!v)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  return (
    <div className="grid gap-8">
      <section className="grid gap-2" aria-labelledby="site-settings">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="site-settings" className="text-lg font-semibold">
            {L["settings.title"]}
          </h2>
          {canEditSettings ? (
            <NextLink href={"/admin/settings/site" as Route} className={buttonVariants({ variant: "outline" })}>
              {L["settings.editSite"]}
            </NextLink>
          ) : null}
        </div>
        <dl>
          <Row label={L["settings.canonicalOrigin"] ?? ""} value={s.canonical_origin} />
          <Row label={L["settings.analytics"] ?? ""} value={s.analytics_enabled ? L["settings.analyticsOn"] : L["settings.analyticsOff"]} />
          <Row label={L["settings.gaId"] ?? ""} value={s.ga_measurement_id ?? notSet} />
          <Row label={L["settings.ogImage"] ?? ""} value={s.default_og_image_media_id ?? notSet} />
          <Row label={L["settings.socialLinks"] ?? ""} value={social || notSet} />
          <Row label={L["settings.brandVoice"] ?? ""} value={s.brand_voice || notSet} />
          <Row label={L["settings.adsId"] ?? ""} value={s.google_ads_conversion_id ?? notSet} />
          <Row label={L["settings.pixelId"] ?? ""} value={s.meta_pixel_id ?? notSet} />
        </dl>
      </section>
      <section className="grid gap-2" aria-labelledby="site-company">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="site-company" className="text-lg font-semibold">
            {L["settings.company"]}
          </h2>
          {canEditSettings ? (
            <NextLink href={"/admin/settings/company" as Route} className={buttonVariants({ variant: "outline" })}>
              {L["settings.editSite"]}
            </NextLink>
          ) : null}
        </div>
        {summary.missingCompany.length ? (
          <Alert variant="destructive">
            <AlertDescription>
              {L["issue.company_identification_missing"]} ({summary.missingCompany.join(", ")})
            </AlertDescription>
          </Alert>
        ) : null}
        <address className="grid gap-1 text-sm not-italic">
          <span className="font-medium">{c.legalName ?? notSet}</span>
          {c.tradeName ? <span>{c.tradeName}</span> : null}
          {c.addressLines.map((l) => (
            <span key={l}>{l}</span>
          ))}
          {c.enterpriseNumber ? <span>{c.enterpriseNumber}</span> : null}
          {c.vatNumber ? <span>{c.vatNumber}</span> : null}
          {c.email ? <span>{c.email}</span> : null}
          {c.phone ? <span>{c.phone}</span> : null}
        </address>
      </section>
    </div>
  );
}
