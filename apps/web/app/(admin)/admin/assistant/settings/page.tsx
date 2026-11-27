import { requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { getSetting } from "@/lib/settings";
import type { AssistantSettingValue } from "@/modules/assistant/config";
import { TOOLS } from "@/modules/assistant/server/tools";
import { SURFACE } from "@/modules/assistant/ui/admin/parts";
import { AssistantHeader } from "../assistant-header";
import { SettingsForm } from "@/modules/assistant/ui/admin/settings-form";

export const dynamic = "force-dynamic";

const KEYS = [
  "switches", "enabled", "coachEnabled", "roles", "model", "fallback", "none", "effort", "effort_none", "effort_low", "effort_medium", "effort_high",
  "maxTokens", "budget", "daily", "monthly", "limits", "perMinute", "perDay", "perConversation", "perIp", "sales", "contactAfter", "tone", "prices",
  "in", "out", "cacheRead", "cacheWrite", "save", "saved", "error", "adviceTitle", "autoApply", "adviceFlows",
];

/**
 * `/admin/assistant/settings` (`assistant.manage`): the settings form, and the register of what the
 * agent may do (every tool, per role), so it is always clear what the agent can and cannot touch.
 */
export default async function AssistantSettingsPage() {
  await requireStaff({ permission: "assistant.manage" });
  const locale = await adminLocale();
  const tr = translator(locale);
  const settings = (await getSetting(await getAppDb(), "assistant")) as AssistantSettingValue;
  const labels = Object.fromEntries([...KEYS.map((k) => [k, tr(`assistant.admin.settings.${k}`)]), ...(["guide", "coach", "analyst"] as const).map((r) => [`role.${r}`, tr(`assistant.admin.role.${r}`)])]);

  return (
    <div className="grid gap-4">
      <AssistantHeader active="settings" canManage tr={tr} />
      <p className="max-w-3xl text-[0.8125rem] text-muted-foreground">{tr("assistant.admin.settings.subtitle")}</p>
      <SettingsForm initial={settings} labels={labels} />
      <section className={`${SURFACE} grid gap-3 p-5`} aria-labelledby="register-h">
        <h2 id="register-h">
          {tr("assistant.admin.settings.register")}
        </h2>
        <p className="text-sm text-muted-foreground">{tr("assistant.admin.settings.registerIntro")}</p>
        <ul className="grid gap-2 sm:grid-cols-2">
          {TOOLS.map((t) => (
            <li key={t.name} className="flex items-start gap-3 rounded-xl border px-3 py-2.5 text-sm">
              <code className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-xs">{t.name}</code>
              <span>
                {tr(`assistant.admin.tool.${t.name}`)}
                <span className="block text-xs text-muted-foreground">{t.roles.map((r) => tr(`assistant.admin.role.${r}`)).join(" · ")}</span>
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
