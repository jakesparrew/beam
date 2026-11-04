import { Card, CardContent, CardHeader, CardTitle } from "@beam/ui";
import { CONSENT_PURPOSES } from "@beam/core/crm";
import { LOCALES } from "@beam/core/i18n";
import { hasPermission, requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { listConsentWordings } from "@/modules/crm/queries";
import { ConsentWordingPublisher } from "@/modules/crm/ui/consent-panel";

const localeKey = (l: string) => `crm.enums.locale.${l.replace("-", "_")}`;

/**
 * `/admin/persons/consent-wordings` (`persons.read`; publish `settings.write`), crm spec 5.1:
 * per purpose the current version's text in each locale and the earlier versions. A published
 * version never changes; publishing writes the next version (all three locales required).
 */
export default async function ConsentWordingsPage() {
  const actor = await requireStaff({ permission: "persons.read" });
  const locale = await adminLocale();
  const tr = translator(locale);
  const canPublish = hasPermission(actor, "settings.write");
  const rows = await listConsentWordings(await getAppDb());
  const dateFmt = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "Europe/Brussels" });
  const localeLabels = Object.fromEntries(LOCALES.map((l) => [l, tr(localeKey(l))])) as Record<(typeof LOCALES)[number], string>;

  return (
    <div className="grid gap-6">
      <header className="grid gap-1">
        <h1 className="text-2xl font-semibold">{tr("crm.consentWordings.title")}</h1>
        <p className="text-sm text-muted-foreground">{tr("crm.consentWordings.intro")}</p>
      </header>
      {CONSENT_PURPOSES.map((purpose) => {
        const versions = rows.filter((r) => r.purpose === purpose && r.publishedAt);
        const [current, ...earlier] = versions;
        return (
          <Card key={purpose}>
            <CardHeader>
              <CardTitle>
                {tr(`crm.enums.consent_purpose.${purpose}`)}
                {current ? <span className="ml-2 text-sm font-normal text-muted-foreground">{tr("crm.consentWordings.current_version", { version: current.version })}</span> : null}
              </CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4">
              {current ? (
                <dl className="grid gap-2">
                  {LOCALES.map((l) => (
                    <div key={l} className="grid gap-0.5">
                      <dt className="text-xs font-semibold uppercase text-muted-foreground">{localeLabels[l]}</dt>
                      <dd className="whitespace-pre-line text-sm">{current.text[l] ?? ""}</dd>
                    </div>
                  ))}
                </dl>
              ) : (
                <p className="text-sm text-muted-foreground">{tr("crm.consentWordings.none")}</p>
              )}
              {earlier.length ? (
                <details>
                  <summary className="cursor-pointer text-sm font-medium">{tr("crm.consentWordings.history")}</summary>
                  <ul className="mt-2 grid gap-2">
                    {earlier.map((v) => (
                      <li key={v.version} className="text-sm">
                        <span className="font-medium">{tr("crm.consentWordings.current_version", { version: v.version })}</span>
                        {v.publishedAt ? <span className="ml-2 text-muted-foreground">{dateFmt.format(v.publishedAt)}</span> : null}
                        <p className="whitespace-pre-line text-muted-foreground">{v.text[locale] ?? v.text.en ?? ""}</p>
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}
              {canPublish ? (
                <ConsentWordingPublisher
                  purpose={purpose}
                  initial={current?.text ?? {}}
                  labels={{
                    publish: tr("crm.consentWordings.publish"),
                    confirm: tr("crm.consentWordings.publish_confirm"),
                    published: tr("crm.consentWordings.published", { version: "{version}" }),
                    error: tr("crm.common.missing_locales", { locales: LOCALES.map((l) => localeLabels[l]).join(", ") }),
                    missing: tr("crm.common.required"),
                    complete: tr("crm.common.yes"),
                    field: tr("crm.consentWordings.publish"),
                    locales: localeLabels,
                  }}
                />
              ) : null}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
