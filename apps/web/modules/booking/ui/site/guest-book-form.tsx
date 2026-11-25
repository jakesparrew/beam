"use client";
/**
 * Step 1 of the public booking flow (owner's review 8): the details and the way to pay for one
 * chosen session, without an account. A guest gives email, full name and phone; a signed-in client
 * books as themselves and may pay with their package. Payment: this session (the method, such as
 * Bancontact or card, is picked on Stripe's page), the client's own package, or a package bought
 * now with one of its sessions used for this booking. Children (owner's review 1) come as rows
 * under the adult on sessions that take them. The page's server action returns the error with
 * the typed values, so nothing is lost and no detail goes into the URL; success redirects to
 * step 2 (review and pay).
 */
import { useActionState } from "react";

export type GuestBookState = { error: string | null; fields: string[]; values: Record<string, string>; n: number };

export type GuestBookLabels = {
  detailsTitle: string;
  detailsIntro: string;
  email: string;
  firstName: string;
  lastName: string;
  phone: string;
  signInTitle: string;
  signInBody: string;
  signIn: string;
  signedIn: string | null;
  payTitle: string;
  kidsTitle: string;
  kidsBody: string;
  kidFirstName: string;
  kidAge: string;
  ageNone: string;
  ageChild: string;
  ageYouth: string;
  emergencyTitle: string;
  emergencyName: string;
  emergencyPhone: string;
  acceptTerms: string;
  readTerms: string;
  submit: string;
  next: string;
};

export type GuestBookFormProps = {
  action: (prev: GuestBookState, fd: FormData) => Promise<GuestBookState>;
  clientKey: string;
  /** False for a guest (the details fields are shown). */
  signedIn: boolean;
  loginHref: string;
  payOptions: Array<{ value: string; label: string; hint: string | null }>;
  /** Children rows (at most `max`) when the session takes children. */
  kids: { max: number } | null;
  emergency: boolean;
  terms: { href: string | null } | null;
  labels: GuestBookLabels;
};

const LEGEND = "font-display mb-1 text-xl";
const OPTION =
  "flex min-h-11 cursor-pointer items-start gap-3 rounded-2xl border-2 border-border bg-card p-4 transition hover:border-[#212842]/40 has-[:checked]:border-[#212842] has-[:checked]:bg-[#fffaef]";
const INPUT =
  "h-12 w-full rounded-xl border border-input bg-card px-4 text-base outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40 aria-[invalid=true]:border-destructive";

const INITIAL: GuestBookState = { error: null, fields: [], values: {}, n: 0 };

export function GuestBookForm(p: GuestBookFormProps) {
  const [state, formAction, pending] = useActionState(p.action, INITIAL);
  const v = (name: string) => state.values[name] ?? "";
  const bad = (name: string) => (state.fields.includes(name) ? true : undefined);
  const errId = "guest-book-error";
  const text = (name: string, label: string, opts: { type?: string; autoComplete?: string; maxLength?: number; minLength?: number; required?: boolean } = {}) => (
    <label className="grid gap-1.5 text-sm font-medium">
      {label}
      <input
        name={name}
        type={opts.type ?? "text"}
        required={opts.required ?? true}
        autoComplete={opts.autoComplete ?? "off"}
        maxLength={opts.maxLength ?? 100}
        minLength={opts.minLength}
        defaultValue={v(name)}
        aria-invalid={bad(name)}
        aria-describedby={bad(name) ? errId : undefined}
        className={INPUT}
      />
    </label>
  );
  const checkedPay = state.values.pay ?? p.payOptions[0]?.value;
  const kidRows = p.kids ? Array.from({ length: p.kids.max }, (_, i) => i) : [];
  const kidsOpen = kidRows.some((i) => v(`kids.${i}.firstName`) || v(`kids.${i}.ageGroup`));

  return (
    <form key={state.n} action={formAction} className="grid gap-8" data-testid="guest-book-form">
      <input type="hidden" name="clientKey" value={p.clientKey} />
      {state.error ? (
        <p id={errId} role="alert" className="rounded-2xl border border-destructive/40 bg-destructive/5 p-4 text-sm" data-testid="guest-book-error">
          {state.error}
        </p>
      ) : null}

      {p.signedIn ? (
        p.labels.signedIn ? <p className="text-lg">{p.labels.signedIn}</p> : null
      ) : (
        <div className="grid gap-6 md:grid-cols-[1.4fr_1fr]">
          <fieldset className="grid content-start gap-4">
            <legend className={LEGEND}>{p.labels.detailsTitle}</legend>
            <p className="-mt-2 text-sm text-muted-foreground">{p.labels.detailsIntro}</p>
            {text("email", p.labels.email, { type: "email", autoComplete: "email", maxLength: 254 })}
            <div className="grid gap-4 sm:grid-cols-2">
              {text("firstName", p.labels.firstName, { autoComplete: "given-name" })}
              {text("lastName", p.labels.lastName, { autoComplete: "family-name" })}
            </div>
            {text("phone", p.labels.phone, { type: "tel", autoComplete: "tel", maxLength: 40, minLength: 6 })}
          </fieldset>
          <div className="grid content-start gap-3 rounded-2xl bg-[#f4ead3] p-6">
            <h3 className="font-semibold">{p.labels.signInTitle}</h3>
            <p className="text-sm text-[#212842]/75">{p.labels.signInBody}</p>
            <a
              href={p.loginHref}
              className="inline-flex items-center justify-center justify-self-start rounded-full bg-[#212842] px-6 py-3 text-sm font-semibold text-[#fffaef] hover:bg-[#2b3354]"
            >
              {p.labels.signIn}
            </a>
          </div>
        </div>
      )}

      <fieldset className="grid gap-3">
        <legend className={LEGEND}>{p.labels.payTitle}</legend>
        {p.payOptions.map((o) => (
          <label key={o.value} className={OPTION}>
            <input type="radio" name="pay" value={o.value} defaultChecked={o.value === checkedPay} className="mt-1 size-5 accent-[#212842]" data-testid={`pay-${o.value}`} />
            <span className="flex flex-col">
              <span className="font-medium">{o.label}</span>
              {o.hint ? <span className="text-sm text-muted-foreground">{o.hint}</span> : null}
            </span>
          </label>
        ))}
      </fieldset>

      {p.kids ? (
        <details open={kidsOpen} className="rounded-2xl border border-border p-5" data-testid="kids">
          <summary className="cursor-pointer font-display text-xl">{p.labels.kidsTitle}</summary>
          <p className="mt-2 text-sm text-muted-foreground">{p.labels.kidsBody}</p>
          <div className="mt-4 grid gap-4">
            {kidRows.map((i) => (
              <div key={i} className="grid gap-3 sm:grid-cols-[1fr_14rem]">
                <label className="grid gap-1.5 text-sm font-medium">
                  {p.labels.kidFirstName.replace("{n}", String(i + 1))}
                  <input name={`kids.${i}.firstName`} maxLength={100} autoComplete="off" defaultValue={v(`kids.${i}.firstName`)} aria-invalid={bad(`children.${i}.firstName`)} className={INPUT} />
                </label>
                <label className="grid gap-1.5 text-sm font-medium">
                  {p.labels.kidAge}
                  <select name={`kids.${i}.ageGroup`} defaultValue={v(`kids.${i}.ageGroup`)} className={INPUT}>
                    <option value="">{p.labels.ageNone}</option>
                    <option value="child">{p.labels.ageChild}</option>
                    <option value="youth">{p.labels.ageYouth}</option>
                  </select>
                </label>
              </div>
            ))}
          </div>
        </details>
      ) : null}

      {p.emergency ? (
        <fieldset className="grid gap-4 sm:grid-cols-2" data-testid="emergency-fields">
          <legend className={`${LEGEND} sm:col-span-2`}>{p.labels.emergencyTitle}</legend>
          {text("emergency.name", p.labels.emergencyName, { maxLength: 200 })}
          {text("emergency.phone", p.labels.emergencyPhone, { type: "tel", maxLength: 40, minLength: 3 })}
        </fieldset>
      ) : null}

      {p.terms ? (
        <div className="space-y-1">
          <label className="flex min-h-11 items-center gap-3 font-medium">
            <input type="checkbox" name="acceptTerms" required defaultChecked={v("acceptTerms") === "on"} className="size-5 accent-[#212842]" data-testid="accept-terms" />
            <span>{p.labels.acceptTerms}</span>
          </label>
          {p.terms.href ? (
            <a href={p.terms.href} target="_blank" rel="noreferrer" className="ml-8 text-sm text-muted-foreground underline underline-offset-4">
              {p.labels.readTerms}
            </a>
          ) : null}
        </div>
      ) : null}

      <div className="grid gap-2">
        <button
          type="submit"
          disabled={pending}
          data-testid="guest-book-submit"
          className="site-gold inline-flex h-14 w-full items-center justify-center gap-3 rounded-full px-8 text-base font-semibold text-[#212842] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-60"
        >
          {p.labels.submit}
          <span aria-hidden="true" className="grid size-9 place-items-center rounded-full bg-[#212842] text-[#fffaef]">
            →
          </span>
        </button>
        <p className="text-center text-sm text-muted-foreground">{p.labels.next}</p>
      </div>
    </form>
  );
}
