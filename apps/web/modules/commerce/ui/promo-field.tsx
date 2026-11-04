import type { Locale } from "@beam/core/i18n";
import { translator } from "@/lib/i18n";

/**
 * The promotion code field of the checkout (rule 13, rule 56): a visible label, the warning of
 * the quote linked with `aria-describedby`, and an "Apply code" button that posts the enclosing
 * form to `applyAction` (so it works without JavaScript and by keyboard).
 */
export function PromoField({
  locale,
  defaultValue,
  warning,
  applyAction,
}: {
  locale: Locale;
  defaultValue: string | null;
  /** A `promo_*` warning code of the quote. */
  warning: string | null;
  applyAction: (fd: FormData) => Promise<void>;
}) {
  const tr = translator(locale);
  const hintId = "promo-code-warning";
  return (
    <div className="grid gap-1">
      <label htmlFor="promo-code" className="text-sm font-medium">
        {tr("commerce.checkout.promo_label")}
      </label>
      <div className="flex flex-wrap gap-2">
        <input
          id="promo-code"
          name="promoCode"
          defaultValue={defaultValue ?? ""}
          autoComplete="off"
          maxLength={40}
          aria-invalid={warning ? true : undefined}
          aria-describedby={warning ? hintId : undefined}
          className="h-11 min-w-0 flex-1 rounded-md border px-3 uppercase"
        />
        <button type="submit" formAction={applyAction} formNoValidate className="min-h-11 rounded-md border px-4 text-sm font-medium">
          {tr("commerce.checkout.promo_apply")}
        </button>
      </div>
      {warning ? (
        <p id={hintId} className="text-sm text-amber-800 dark:text-amber-300">
          {tr(`commerce.errors.${warning}`)}
        </p>
      ) : null}
    </div>
  );
}
