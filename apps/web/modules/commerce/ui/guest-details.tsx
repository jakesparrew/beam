/**
 * The site guest's details (owner's review 8): email, first and last name and phone, the same
 * details the booking flow asks, so a shop order needs no account. Used by the site checkout's
 * first step and the gift page; `field` marks the field a `validation` error named.
 */
import type { Locale } from "@beam/core/i18n";
import { translator } from "@/lib/i18n";

const FIELDS = [
  { name: "email", type: "email", autoComplete: "email", maxLength: 254, minLength: undefined },
  { name: "firstName", type: "text", autoComplete: "given-name", maxLength: 100, minLength: undefined },
  { name: "lastName", type: "text", autoComplete: "family-name", maxLength: 100, minLength: undefined },
  { name: "phone", type: "tel", autoComplete: "tel", maxLength: 40, minLength: 6 },
] as const;

const LABEL = { email: "email_label", firstName: "first_name", lastName: "last_name", phone: "phone" } as const;

export function GuestDetailsFields({ locale, field, emailLabel, defaults }: { locale: Locale; field?: string | null; emailLabel?: string; defaults?: Partial<Record<(typeof FIELDS)[number]["name"], string>> }) {
  const tr = translator(locale);
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {FIELDS.map((f) => {
        const invalid = field === f.name;
        const hint = f.name === "email" ? tr("commerce.checkout.email_hint") : f.name === "phone" ? tr("commerce.checkout.phone_hint") : null;
        const described = [hint ? `${f.name}-hint` : null, invalid ? `${f.name}-error` : null].filter(Boolean).join(" ") || undefined;
        return (
          <div key={f.name} className={`grid content-start gap-1 ${f.name === "email" || f.name === "phone" ? "sm:col-span-2" : ""}`}>
            <label htmlFor={f.name} className="text-sm font-medium">
              {f.name === "email" && emailLabel ? emailLabel : tr(`commerce.checkout.${LABEL[f.name]}`)}
            </label>
            <input
              id={f.name}
              name={f.name}
              type={f.type}
              required
              defaultValue={defaults?.[f.name]}
              autoComplete={f.autoComplete}
              maxLength={f.maxLength}
              minLength={f.minLength}
              aria-invalid={invalid ? true : undefined}
              aria-describedby={described}
              className="h-11 rounded-md border px-3"
            />
            {hint ? (
              <p id={`${f.name}-hint`} className="text-sm text-muted-foreground">
                {hint}
              </p>
            ) : null}
            {invalid ? (
              <p id={`${f.name}-error`} className="text-sm text-red-700 dark:text-red-300">
                {tr(f.name === "email" ? "commerce.errors.email_required" : "commerce.errors.validation")}
              </p>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/** The details a guest typed, for `startCheckout` (empty strings dropped). */
export function guestDetailsFrom(fd: FormData): { email?: string; firstName?: string; lastName?: string; phone?: string } {
  const out: Record<string, string> = {};
  for (const f of FIELDS) {
    const v = fd.get(f.name);
    if (typeof v === "string" && v.trim()) out[f.name] = v.trim();
  }
  return out;
}
