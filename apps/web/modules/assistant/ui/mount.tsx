/**
 * Mounts the widget: the guide in the site layout, the coach in the portal layout. Renders nothing
 * when the role is switched off in `settings.assistant`, so the switch in the back-office takes the
 * launcher off every page at once.
 */
import "server-only";
import type { Locale } from "@beam/core/i18n";
import { poppins, rufina } from "@/app/fonts";
import { getAppDb } from "@/lib/ctx";
import { translator } from "@/lib/i18n";
import { getSetting } from "@/lib/settings";
import { getCurrentConsents, getPerson } from "@/modules/crm/api";
import type { AssistantSettingValue } from "../config";
import { AssistantWidget, type AssistantWidgetLabels } from "./widget";

export async function AssistantMount({ role, locale, personId }: { role: "guide" | "coach"; locale: Locale; personId?: string | null }) {
  let settings: AssistantSettingValue;
  try {
    settings = (await getSetting(await getAppDb(), "assistant")) as AssistantSettingValue;
  } catch {
    return null;
  }
  if (role === "guide" && !settings.enabled) return null;
  if (role === "coach" && (!settings.coach_enabled || !personId)) return null;

  const tr = translator(locale);
  const db = await getAppDb();
  let firstName = "";
  let checkinsAllowed: boolean | null = null;
  if (role === "coach" && personId) {
    const [person, consents] = await Promise.all([getPerson(db, personId).catch(() => null), getCurrentConsents(db, personId).catch(() => null)]);
    firstName = person?.firstName ?? "";
    checkinsAllowed = consents?.ai_processing?.status === "granted";
  }
  const coach = role === "coach";
  const labels: AssistantWidgetLabels = {
    launcher: tr(coach ? "assistant.widget.launcherCoach" : "assistant.widget.launcher"),
    title: tr(coach ? "assistant.widget.coachTitle" : "assistant.widget.guideTitle"),
    subtitle: tr(coach ? "assistant.widget.coachSubtitle" : "assistant.widget.guideSubtitle"),
    greeting: coach ? tr("assistant.widget.greetingCoach", { name: firstName }).replace(/\s+,/, ",") : tr("assistant.widget.greetingGuide"),
    starters: coach ? ["c1", "c2", "c3"].map((k) => tr(`assistant.widget.starter.${k}`)) : ["g1", "g2", "g3", "g4"].map((k) => tr(`assistant.widget.starter.${k}`)),
    placeholder: tr("assistant.widget.placeholder"),
    send: tr("assistant.widget.send"),
    close: tr("assistant.widget.close"),
    open: tr("assistant.widget.open"),
    newChat: tr("assistant.widget.newChat"),
    disclaimer: tr("assistant.widget.disclaimer"),
    thinking: tr("assistant.widget.thinking"),
    relayed: tr("assistant.widget.relayed"),
    staff: tr("assistant.widget.staff"),
    helpful: tr("assistant.widget.helpful"),
    notHelpful: tr("assistant.widget.notHelpful"),
    book: tr("assistant.widget.book"),
    freeOne: tr("assistant.widget.free", { count: 1 }),
    freeMany: tr("assistant.widget.free", { count: 7 }).replace("7", "#"),
    handoff: tr("assistant.widget.handoff"),
    error: tr("assistant.widget.error"),
    contact: {
      title: tr("assistant.widget.contact.title"),
      body: tr("assistant.widget.contact.body"),
      firstName: tr("assistant.widget.contact.firstName"),
      email: tr("assistant.widget.contact.email"),
      phone: tr("assistant.widget.contact.phone"),
      newsletter: tr("assistant.widget.contact.newsletter"),
      submit: tr("assistant.widget.contact.submit"),
      privacy: tr("assistant.widget.contact.privacy"),
      error: tr("assistant.widget.contact.error"),
    },
    ...(coach && checkinsAllowed !== null ? { checkins: { label: tr("assistant.widget.checkins.label"), hint: tr("assistant.widget.checkins.hint") } } : {}),
  };
  return (
    <div className={`${poppins.variable} ${rufina.variable} font-sans`}>
      <AssistantWidget role={role} locale={locale} labels={labels} checkinsAllowed={checkinsAllowed} />
    </div>
  );
}
