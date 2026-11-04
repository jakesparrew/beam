import { ACQUISITION_SOURCES } from "@beam/core/crm";
import { requireStaff } from "@/lib/auth";
import { adminLocale, messageTemplate, translator } from "@/lib/i18n";
import { PersonForm } from "@/modules/crm/ui/person-form";
import { channelOptions, localeOptions, personFormLabels, sourceOptions } from "@/modules/crm/ui/status-badge";

/** `/admin/persons/new` (`persons.write`), crm spec 5.1: the duplicate panel appears at or above score 50. */
export default async function NewPersonPage() {
  await requireStaff({ permission: "persons.write" });
  const locale = await adminLocale();
  const tr = translator(locale);
  return (
    <div className="grid gap-6">
      <h1 className="text-2xl font-semibold">{tr("crm.persons.new.title")}</h1>
      <PersonForm
        mode="create"
        initial={{
          email: "",
          phone: "",
          firstName: "",
          lastName: "",
          locale,
          street: "",
          number: "",
          box: "",
          postalCode: "",
          city: "",
          country: "BE",
          birthOn: "",
          preferredChannel: "",
          acquisitionSource: "manual",
          acquisitionCampaign: "",
          linkedinUrl: "",
          emergencyName: "",
          emergencyPhone: "",
          emergencyRelation: "",
        }}
        labels={personFormLabels(tr, (key) => messageTemplate(locale, key))}
        locales={localeOptions(tr)}
        channels={channelOptions(tr)}
        sources={sourceOptions(tr, ACQUISITION_SOURCES)}
      />
    </div>
  );
}
