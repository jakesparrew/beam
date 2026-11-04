import { notFound, redirect } from "next/navigation";
import { persons } from "@beam/db/schema";
import { ACQUISITION_SOURCES } from "@beam/core/crm";
import { requireStaff } from "@/lib/auth";
import { eq, getAppDb } from "@/lib/ctx";
import { adminLocale, messageTemplate, translator } from "@/lib/i18n";
import { resolveCanonicalPersonId } from "@/modules/crm/api";
import { PersonForm } from "@/modules/crm/ui/person-form";
import { channelOptions, localeOptions, personFormLabels, sourceOptions } from "@/modules/crm/ui/status-badge";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `/admin/persons/[id]/edit` (`persons.write`): the identity form with the row `version`; a merged id redirects to its winner. */
export default async function EditPersonPage({ params }: { params: Promise<{ id: string }> }) {
  await requireStaff({ permission: "persons.write" });
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const db = await getAppDb();
  const canonical = await resolveCanonicalPersonId(db, id).catch(() => null);
  if (!canonical) notFound();
  if (canonical !== id) redirect(`/admin/persons/${canonical}/edit` as never);
  const [p] = await db.select().from(persons).where(eq(persons.id, id));
  if (!p || p.erasedAt) notFound();
  const locale = await adminLocale();
  const tr = translator(locale);
  return (
    <div className="grid gap-6">
      <h1 className="text-2xl font-semibold">{tr("crm.persons.edit.title")}</h1>
      <PersonForm
        mode="edit"
        personId={p.id}
        version={p.version}
        initial={{
          email: p.email ?? "",
          phone: p.phone ?? "",
          firstName: p.firstName ?? "",
          lastName: p.lastName ?? "",
          locale: p.locale,
          street: p.address?.street ?? "",
          number: p.address?.number ?? "",
          box: p.address?.box ?? "",
          postalCode: p.address?.postal_code ?? "",
          city: p.address?.city ?? "",
          country: p.address?.country ?? "BE",
          birthOn: p.birthOn ?? "",
          preferredChannel: p.preferredChannel ?? "",
          acquisitionSource: typeof p.acquisition.source === "string" ? p.acquisition.source : "",
          acquisitionCampaign: "",
          linkedinUrl: p.linkedinUrl ?? "",
          emergencyName: p.emergencyContact?.name ?? "",
          emergencyPhone: p.emergencyContact?.phone ?? "",
          emergencyRelation: p.emergencyContact?.relation ?? "",
        }}
        labels={personFormLabels(tr, (key) => messageTemplate(locale, key))}
        locales={localeOptions(tr)}
        channels={channelOptions(tr)}
        sources={sourceOptions(tr, ACQUISITION_SOURCES)}
      />
    </div>
  );
}
