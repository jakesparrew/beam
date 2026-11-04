import { requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { listStaffForAssignment } from "@/modules/platform/api";
import { companyFormLabels, companyOptions } from "@/modules/crm/companies/queries";
import { CompanyForm } from "@/modules/crm/ui/company-form";

/** `/admin/companies/new` (`crm.b2b`), crm spec 5.1. */
export default async function NewCompanyPage() {
  const actor = await requireStaff({ permission: "crm.b2b" });
  const locale = await adminLocale();
  const tr = translator(locale);
  const staff = await listStaffForAssignment(await getAppDb(), { permission: "crm.b2b" });
  const { sizes, statuses } = companyOptions(tr);
  return (
    <div className="grid gap-6">
      <h1 className="text-2xl font-semibold">{tr("crm.companies.create")}</h1>
      <CompanyForm
        initial={{
          name: "",
          vatNumber: "",
          street: "",
          number: "",
          postalCode: "",
          city: "",
          country: "BE",
          website: "",
          industry: "",
          size: "",
          status: "target",
          ownerUserId: actor.userId,
          notes: "",
          isPartner: false,
          partnerCommissionPct: "",
        }}
        sizes={sizes}
        statuses={statuses}
        owners={staff.map((s) => ({ value: s.userId, label: s.name }))}
        labels={companyFormLabels(tr)}
      />
    </div>
  );
}
