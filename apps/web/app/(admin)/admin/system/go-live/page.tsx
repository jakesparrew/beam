import { Badge } from "@beam/ui";
import { GO_LIVE_CONFIRM_ROLES, type GateItemKey } from "@beam/core/platform";
import { hasPermission, requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { catalogueSection, getGoLiveGate } from "@/modules/platform/queries";
import { GateChecklist } from "@/modules/platform/ui/gate-checklist";

/** The runbook that explains how to check each gate item (`docs/runbooks/`). */
const RUNBOOK: Record<GateItemKey, string> = {
  dpa_signed: "docs/runbooks/go-live.md#dpa",
  subprocessors_confirmed: "docs/runbooks/subprocessors.md",
  region_confirmed: "docs/runbooks/subprocessors.md#locations",
  transfers_documented: "docs/runbooks/subprocessors.md#transfers",
  ai_no_training_confirmed: "docs/runbooks/subprocessors.md#anthropic",
  retention_agreed: "docs/runbooks/go-live.md#retention",
  export_tested: "docs/runbooks/go-live.md#export",
  deletion_tested: "docs/runbooks/go-live.md#deletion",
  security_confirmed: "docs/runbooks/security-testing.md",
  backup_confirmed: "docs/runbooks/backup.md",
  recovery_confirmed: "docs/runbooks/restore.md",
  permissions_configured: "docs/runbooks/access.md",
  acceptance_passed: "docs/runbooks/go-live.md#acceptance",
};

/**
 * `/admin/system/go-live` (`system.jobs` to view; owner or technical_admin to confirm): the 13 gate
 * items with state, confirmer, date and note (PL-77); `security_confirmed` needs a fresh pentest and
 * no open critical or high incident (PL-85).
 */
export default async function GoLivePage() {
  const actor = await requireStaff({ permission: "system.jobs" });
  const locale = await adminLocale();
  const tr = translator(locale);
  const t = (k: string, p?: Record<string, string | number>) => tr(`platform.go_live.${k}`, p);
  const gate = await getGoLiveGate(await getAppDb());
  const canConfirm = (GO_LIVE_CONFIRM_ROLES as readonly string[]).includes(actor.roleKey) && hasPermission(actor, "settings.write");

  return (
    <div className="grid gap-6">
      <header className="grid gap-2">
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <p className="text-muted-foreground">{t("intro")}</p>
        <p className="flex items-center gap-2 text-sm">
          <Badge variant={gate.complete ? "success" : "warning"}>{gate.complete ? t("complete") : t("incomplete")}</Badge>
          {t("progress", { confirmed: gate.confirmed, total: gate.total })}
        </p>
        {canConfirm ? null : <p className="text-sm text-muted-foreground">{t("view_only")}</p>}
      </header>
      <GateChecklist
        items={gate.items.map((i) => ({ ...i, runbook: RUNBOOK[i.key] }))}
        canConfirm={canConfirm}
        locale={locale}
        labels={catalogueSection(locale, "platform.go_live")}
        errors={catalogueSection(locale, "platform.errors")}
      />
    </div>
  );
}
