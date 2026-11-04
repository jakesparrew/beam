/**
 * `DeskCreditsBadge` (credits spec section 5, decision 42c): one line in large type for booking's
 * check-in desk and commerce's POS: "Day: 4 · Night: 1 · Member until 31 Dec · Past due". Reads
 * through `getDeskCredits` and needs `credits.read` (reception has it); renders nothing otherwise.
 * `DeskCreditsLine` renders given data (for hosts that already loaded it, and for tests).
 */
import { Badge } from "@beam/ui";
import { formatDate, formatMoney, type Locale } from "@beam/core/i18n";
import type { CreditKind } from "@beam/core/credits";
import { actorFromSession, getSession, hasPermission } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { translator } from "@/lib/i18n";
import { getDeskCredits } from "../queries";

export type DeskCredits = {
  byKind: { kind: CreditKind; remainingUnits: number }[];
  membership: { status: string; periodEndAt: Date } | null;
};

/** The badge's parts in the page locale (also used by hosts that render plain text). */
export function deskCreditsParts(data: DeskCredits, locale: Locale): { text: string; pastDue: boolean } {
  const tr = translator(locale);
  const parts: string[] = [];
  for (const k of data.byKind) {
    if (k.remainingUnits <= 0) continue;
    parts.push(k.kind === "euro" ? tr("credits.admin.desk.euro", { amount: formatMoney(k.remainingUnits, locale) }) : tr(`credits.admin.desk.${k.kind}`, { count: k.remainingUnits }));
  }
  if (data.membership) parts.push(tr("credits.admin.desk.member_until", { date: formatDate(data.membership.periodEndAt, locale, "medium") }));
  if (parts.length === 0) parts.push(tr("credits.admin.desk.nothing"));
  return { text: parts.join(" · "), pastDue: data.membership?.status === "past_due" };
}

export function DeskCreditsLine({ data, locale }: { data: DeskCredits; locale: Locale }) {
  const tr = translator(locale);
  const { text, pastDue } = deskCreditsParts(data, locale);
  return (
    <p className="flex flex-wrap items-center gap-2 text-xl font-semibold" aria-label={tr("credits.admin.desk.label")}>
      <span>{text}</span>
      {pastDue ? (
        <Badge variant="destructive" className="text-base">
          {tr("credits.admin.desk.past_due")}
        </Badge>
      ) : null}
    </p>
  );
}

export async function DeskCreditsBadge({ personId, locale }: { personId: string; locale: Locale }) {
  const actor = actorFromSession(await getSession());
  if (!actor || actor.kind !== "staff" || !hasPermission(actor, "credits.read")) return null;
  const data = await getDeskCredits(await getAppDb(), personId).catch(() => null);
  if (!data) return null;
  return <DeskCreditsLine data={data} locale={locale} />;
}
