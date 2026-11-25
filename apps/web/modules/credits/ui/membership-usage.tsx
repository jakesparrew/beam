/**
 * `MembershipUsage`: what a membership gives this period, the same for the member
 * (`/[locale]/account/membership`) and for staff (the person page): the free sessions with what
 * remains (an either/or choice is shown as open or as chosen) and the member discounts per
 * category. Server component.
 */
import type { Locale } from "@beam/core/i18n";
import { translator } from "@/lib/i18n";
import type { MyMembership } from "../queries";
import { UnitsProgress, unitsOfText, unitsText } from "./package-card";

type Tr = ReturnType<typeof translator>;
type Included = MyMembership["included"][number];

const optionText = (g: Pick<Included, "kind" | "baseUnits">, tr: Tr) => tr(`credits.portal.membership.option_${g.kind}`, { count: g.baseUnits });

function FreeSessions({ m, locale, tr }: { m: MyMembership; locale: Locale; tr: Tr }) {
  const options = m.included.filter((g) => g.isChoice);
  const chosenKind = m.choice?.state === "chosen" ? m.choice.kind : null;
  // Forfeited options (revoked by the choice) are not shown as a bar.
  const bars = m.included.filter((g) => g.status !== "revoked");
  return (
    <section aria-labelledby="membership-included" className="grid gap-3">
      <h2 id="membership-included" className="text-base font-semibold">
        {tr("credits.portal.membership.free_sessions")}
      </h2>
      {m.choice?.state === "open" ? (
        <p className="text-sm" data-testid="membership-choice-open">
          {tr("credits.portal.membership.choice_open", { options: options.map((g) => optionText(g, tr)).join(` ${tr("credits.portal.membership.choice_or")} `) })}
        </p>
      ) : null}
      {chosenKind ? (
        <p className="text-sm" data-testid="membership-choice-chosen">
          {tr("credits.portal.membership.choice_chosen", { option: optionText(options.find((g) => g.kind === chosenKind && g.status !== "revoked") ?? options[0]!, tr) })}
        </p>
      ) : null}
      {bars.length === 0 ? (
        <p className="text-sm text-muted-foreground">{tr("credits.portal.membership.included_none")}</p>
      ) : (
        bars.map((g) => (
          <div key={g.grantId} className="grid gap-1">
            <p className="text-sm font-medium">{unitsText(g.kind, g.remainingUnits, locale, tr)}</p>
            <UnitsProgress
              label={tr("credits.portal.packages.progress", { name: tr(`credits.labels.${g.kind}`) })}
              remaining={g.remainingUnits}
              total={g.baseUnits}
              valueText={unitsOfText(g.kind, g.remainingUnits, g.baseUnits, locale, tr)}
            />
          </div>
        ))
      )}
    </section>
  );
}

function Discounts({ m, locale, tr }: { m: MyMembership; locale: Locale; tr: Tr }) {
  const pct = (n: number) => new Intl.NumberFormat(locale).format(n);
  const lines = m.discounts.length
    ? m.discounts.map((d) =>
        d.scope === "product"
          ? tr("credits.portal.membership.discount_product", { pct: pct(d.pct), product: d.productName?.[locale] ?? "" })
          : tr(`credits.portal.membership.discount_${d.scope}`, { pct: pct(d.pct) }),
      )
    : m.discountPct > 0
      ? [tr("credits.portal.membership.discount_value", { pct: pct(m.discountPct) })]
      : [];
  if (lines.length === 0) return null;
  return (
    <section aria-labelledby="membership-discounts" className="grid gap-2">
      <h2 id="membership-discounts" className="text-base font-semibold">
        {tr("credits.portal.membership.discounts")}
      </h2>
      <ul className="grid gap-1 text-sm" data-testid="membership-discounts">
        {lines.map((text) => (
          <li key={text} className="flex gap-2">
            <span aria-hidden="true">✓</span>
            <span>{text}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function MembershipUsage({ membership: m, locale }: { membership: MyMembership; locale: Locale }) {
  const tr = translator(locale);
  return (
    <>
      <FreeSessions m={m} locale={locale} tr={tr} />
      <Discounts m={m} locale={locale} tr={tr} />
    </>
  );
}
