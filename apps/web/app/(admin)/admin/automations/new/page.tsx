import Link from "next/link";
import { requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale } from "@/lib/i18n";
import { automationLabels, listAutomationOptions, listGroupOptions } from "@/modules/automation/queries";
import { NewAutomationForm } from "@/modules/automation/ui/definition-editor";

/** `/admin/automations/new` (`automations.write`, automation spec 5): create a draft, then open the editor. */
export default async function NewAutomationPage() {
  await requireStaff({ permission: "automations.write" });
  const locale = await adminLocale();
  const l = automationLabels(locale, ["new", "list", "purpose", "errors", "common"]);
  const db = await getAppDb();
  const [groups, automations] = await Promise.all([listGroupOptions(db), listAutomationOptions(db)]);
  return (
    <div className="grid gap-6">
      <div className="grid gap-1">
        <Link href="/admin/automations" className="text-sm text-muted-foreground underline-offset-2 hover:underline">
          {l["common.back"]}
        </Link>
        <h1 className="text-2xl font-semibold">{l["new.title"]}</h1>
        <p className="text-sm text-muted-foreground">{l["new.description"]}</p>
      </div>
      <NewAutomationForm groups={groups} automations={automations} labels={l} />
    </div>
  );
}
