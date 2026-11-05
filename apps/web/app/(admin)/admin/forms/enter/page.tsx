/**
 * `/admin/forms/enter?personId=` (`persons.write`; forms spec section 5, rule ID10): reception and
 * phone intake. Shows the person (first name and masked email), their health declaration status
 * from `hasValidSubmission(db, { personId, formSlug: 'health-declaration' })` ("valid until ..."
 * or "missing"), and the published forms that allow staff entry, each with Start
 * (`startStaffEntry`, the hosted form in a new tab with the staff banner).
 */
import Link from "next/link";
import { formatDate } from "@beam/core/i18n";
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Input } from "@beam/ui";
import { requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { getPerson } from "@/modules/crm/api";
import { hasValidSubmission } from "@/modules/forms/api";
import { listStaffEntryForms, localeNames, screenLabels } from "@/modules/forms/queries";
import { maskEmail } from "@/modules/forms/service/identity";
import { StaffEntryPanel } from "@/modules/forms/ui/admin/staff-entry-panel";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f-]{36}$/i;

export default async function StaffEntryPage({ searchParams }: { searchParams: Promise<{ personId?: string | string[] }> }) {
  await requireStaff({ permission: "persons.write" });
  const sp = await searchParams;
  const personId = typeof sp.personId === "string" && UUID.test(sp.personId) ? sp.personId : null;
  const locale = await adminLocale();
  const tr = translator(locale);
  const db = await getAppDb();
  const person = personId ? await getPerson(db, personId) : null;
  const health = person && !person.erasedAt ? await hasValidSubmission(db, { personId: person.id, formSlug: "health-declaration" }) : null;
  const state = health?.valid ? "valid" : health?.completedAt ? "expired" : "missing";

  return (
    <div className="grid gap-6">
      <header className="grid gap-1">
        <h1 className="text-2xl font-semibold">{tr("forms.enter.title")}</h1>
        <p className="text-sm text-muted-foreground">{tr("forms.enter.intro")}</p>
      </header>

      {!person || person.erasedAt ? (
        <Card>
          <CardContent className="grid gap-3 pt-6">
            {personId ? (
              <p role="alert" className="text-sm text-destructive">
                {tr("forms.enter.person_not_found")}
              </p>
            ) : null}
            <p className="text-sm">{tr("forms.enter.choose_person")}</p>
            <form method="get" className="flex flex-wrap items-end gap-2">
              <label className="grid gap-1 text-sm">
                {tr("forms.enter.person_id")}
                <Input name="personId" className="w-96 max-w-full" required pattern="[0-9a-fA-F-]{36}" defaultValue={sp.personId && typeof sp.personId === "string" ? sp.personId : ""} />
              </label>
              <Button type="submit">{tr("forms.enter.find")}</Button>
            </form>
          </CardContent>
        </Card>
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle>{tr("forms.enter.person")}</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3">
              <p className="text-base">
                <span className="font-medium">{person.firstName ?? "—"}</span>
                {person.email ? <span className="text-muted-foreground"> ({maskEmail(person.email)})</span> : null}
              </p>
              <div className="flex flex-wrap items-center gap-2 text-sm" data-health={state}>
                <span>{tr("forms.enter.health_title")}:</span>
                {state === "valid" ? (
                  <Badge variant="secondary">{health?.expiresAt ? tr("forms.enter.health_valid", { date: formatDate(health.expiresAt, locale) }) : tr("forms.enter.health_valid_open")}</Badge>
                ) : state === "expired" && health?.expiresAt ? (
                  <Badge variant="destructive">{tr("forms.enter.health_expired", { date: formatDate(health.expiresAt, locale) })}</Badge>
                ) : (
                  <Badge variant="destructive">{tr("forms.enter.health_missing")}</Badge>
                )}
              </div>
              <Link className="text-sm underline" href={`/admin/persons/${person.id}` as never}>
                {tr("forms.enter.back_to_person")}
              </Link>
            </CardContent>
          </Card>
          <StaffEntryPanel
            personId={person.id}
            defaultLocale={person.locale}
            forms={(await listStaffEntryForms(db)).map((f) => ({ formId: f.formId, slug: f.slug, name: f.name[locale] || f.slug, kindLabel: tr(`forms.kind.${f.kind}`), locales: f.locales }))}
            localeNames={localeNames(locale)}
            labels={screenLabels(locale, ["enter", "list", "builder"])}
          />
        </>
      )}
    </div>
  );
}
