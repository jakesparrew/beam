import Link from "next/link";
import { notFound } from "next/navigation";
import { wallClock } from "@beam/core/platform";
import { requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { catalogueSection, getAiUsage, getSettingForEdit, getStaffUser } from "@/modules/platform/queries";
import { AiSensitivePanel, SettingsForm } from "@/modules/platform/ui/settings-form";
import { zodToFormFields } from "@/modules/platform/ui/zod-form";

/** Fields changed only through `setAiSensitiveProcessing` (PL-55). */
const SENSITIVE_FIELDS = new Set(["sensitive_enabled", "purpose", "dpia_reference", "enabled_by_user_id", "enabled_at"]);

type AiValue = {
  sensitive_enabled: boolean;
  purpose: string | null;
  dpia_reference: string | null;
  enabled_by_user_id: string | null;
  enabled_at: string | null;
  monthly_budget_cents: number;
  daily_cap_calls: number;
};

/**
 * `/admin/settings/ai` (`settings.write`; the sensitive switch is owner only): budget, daily cap,
 * this month's spend, model prices (generic form of `settings.ai`) and the sensitive-processing panel.
 */
export default async function AiSettingsPage() {
  const actor = await requireStaff({ permission: "settings.write" });
  const locale = await adminLocale();
  const tr = translator(locale);
  const t = (k: string, p?: Record<string, string | number>) => tr(`platform.ai_settings.${k}`, p);
  const db = await getAppDb();
  const setting = await getSettingForEdit(db, "ai");
  if (!setting) notFound();
  const value = setting.value as AiValue;
  const w = wallClock(new Date());
  const usage = await getAiUsage(db, { month: `${w.year}-${String(w.month).padStart(2, "0")}` });
  const enabledBy = value.enabled_by_user_id ? await getStaffUser(db, value.enabled_by_user_id) : null;
  const money = new Intl.NumberFormat(locale, { style: "currency", currency: "EUR" });
  const pct = value.monthly_budget_cents > 0 ? Math.min(100, Math.round((usage.totalCents / value.monthly_budget_cents) * 100)) : 0;
  const isAdmin = actor.roleKey === "owner" || actor.roleKey === "technical_admin";

  return (
    <div className="grid gap-6">
      <header className="grid gap-2">
        <Link href="/admin/settings" className="text-sm text-muted-foreground hover:underline">
          {tr("platform.settings.back")}
        </Link>
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <p className="text-muted-foreground">{t("intro")}</p>
      </header>
      <section className="grid max-w-2xl gap-2" aria-labelledby="ai-spend">
        <h2 id="ai-spend" className="text-lg font-medium">
          {t("month_spend")}
        </h2>
        <p className="text-sm">{t("spend_of_budget", { spend: money.format(usage.totalCents / 100), budget: money.format(value.monthly_budget_cents / 100) })}</p>
        <div className="h-3 w-full overflow-hidden rounded bg-muted" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={t("month_spend")}>
          <div className={pct >= 80 ? "h-full bg-destructive" : "h-full bg-primary"} style={{ width: `${pct}%` }} />
        </div>
        <p className="text-xs text-muted-foreground">{t("daily_cap", { calls: value.daily_cap_calls })}</p>
      </section>
      <section className="grid gap-3" aria-labelledby="ai-budget">
        <h2 id="ai-budget" className="text-lg font-medium">
          {t("budget_title")}
        </h2>
        <SettingsForm
          settingKey="ai"
          version={setting.version}
          value={setting.value}
          fields={zodToFormFields(setting.schema).filter((f) => !SENSITIVE_FIELDS.has(f.path[0] ?? ""))}
          labels={catalogueSection(locale, "platform.settings")}
          errors={catalogueSection(locale, "platform.errors")}
        />
      </section>
      <AiSensitivePanel
        enabled={value.sensitive_enabled}
        purpose={value.purpose}
        dpiaReference={value.dpia_reference}
        enabledBy={enabledBy ? (enabledBy.name ?? enabledBy.email) : null}
        enabledAt={value.enabled_at}
        canEnable={actor.roleKey === "owner"}
        canDisable={isAdmin}
        labels={catalogueSection(locale, "platform.ai_settings")}
        errors={catalogueSection(locale, "platform.errors")}
      />
    </div>
  );
}
