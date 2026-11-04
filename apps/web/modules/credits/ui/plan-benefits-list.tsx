/**
 * `PlanBenefitsList` (credits spec section 5, `/[locale]/account/membership`): the plan's active
 * benefits (`membership_plan_benefits`, including event benefits) in the page locale, in their
 * sort order. A benefit without text in this locale is left out (no fallback language). Server
 * component.
 */
import type { Locale, LocalizedText } from "@beam/core/i18n";
import { translator } from "@/lib/i18n";

export function PlanBenefitsList({ benefits, locale }: { benefits: { benefitId: string; kind: string; text: LocalizedText }[]; locale: Locale }) {
  const tr = translator(locale);
  const items = benefits
    .map((b) => ({ id: b.benefitId, kind: b.kind, text: b.text?.[locale] }))
    .filter((b): b is { id: string; kind: string; text: string } => typeof b.text === "string" && b.text.trim().length > 0);
  if (items.length === 0) return null;
  return (
    <section aria-labelledby="plan-benefits" className="grid gap-2">
      <h2 id="plan-benefits" className="text-lg font-semibold">
        {tr("credits.portal.membership.benefits")}
      </h2>
      <ul className="grid gap-1 text-sm">
        {items.map((b) => (
          <li key={b.id} className="flex gap-2" data-benefit-kind={b.kind}>
            <span aria-hidden="true">✓</span>
            <span>{b.text}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
