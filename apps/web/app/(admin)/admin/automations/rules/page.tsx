import Link from "next/link";
import { hasPermission, requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale } from "@/lib/i18n";
import { automationLabels, getAutomationRules } from "@/modules/automation/queries";
import { RulesForm } from "@/modules/automation/ui/rules-form";

/**
 * `/admin/automations/rules` (R2, automation spec 5, automation-P7; `automations.publish`):
 * frequency caps and quiet hours of automation marketing emails (A-32) and the webhook host
 * allow-list, saved through `updateAutomationRules`. The host field is read-only without
 * `settings.write` (adding a host is a data-export decision).
 */
export default async function AutomationRulesPage() {
  const actor = await requireStaff({ permission: "automations.publish" });
  const locale = await adminLocale();
  const l = automationLabels(locale, ["rules", "common", "errors"]);
  const value = await getAutomationRules(await getAppDb());
  return (
    <div className="grid gap-6">
      <div className="grid gap-1">
        <Link href="/admin/automations/groups" className="text-sm text-muted-foreground underline-offset-2 hover:underline">
          {l["common.back"]}
        </Link>
        <h1 className="text-2xl font-semibold">{l["rules.title"]}</h1>
        <p className="max-w-3xl text-sm text-muted-foreground">{l["rules.description"]}</p>
      </div>
      <RulesForm value={value} canEditHosts={hasPermission(actor, "settings.write")} labels={l} />
    </div>
  );
}
