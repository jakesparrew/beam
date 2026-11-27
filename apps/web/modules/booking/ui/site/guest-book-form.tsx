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
 *
 * Owner decisions, each in its own closed section so the default path stays one session for one
 * adult: other adults (companions, a shared bed on nights), extras with a quantity, more sessions
 * from the next days in the same payment, and a discount code or gift voucher. The running total
 * is an estimate from the public prices shown; the next step shows the order's own quote.
 */
import { useActionState, useEffect, useRef, useState } from "react";
import { readStoredUtm, utmFromSearch } from "@beam/core/site";

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
  companionsTitle: string;
  companionsBody: string;
  companion: string;
  companionEmail: string;
  sharesBed: string;
  addCompanion: string;
  removeCompanion: string;
  extrasTitle: string;
  extrasBody: string;
  fewer: string;
  more: string;
  moreTitle: string;
  moreBody: string;
  kindDay: string;
  kindNight: string;
  codeTitle: string;
  codeLabel: string;
  codeHint: string;
  summaryTitle: string;
  seats: string;
  total: string;
  totalHint: string;
};

/** A session of the booking, labelled on the server. */
export type BookFormSession = { sessionId: string; kind: "day" | "night" | "event"; day: string; time: string; priceCents: number | null; youthCents: number | null; childrenAllowed: boolean };

export type GuestBookFormProps = {
  action: (prev: GuestBookState, fd: FormData) => Promise<GuestBookState>;
  clientKey: string;
  locale: string;
  /** False for a guest (the details fields are shown). */
  signedIn: boolean;
  loginHref: string;
  /** `packageCents`/`packageKind`: the package bought with this option (running total only). */
  payOptions: Array<{ value: string; label: string; hint: string | null; packageCents?: number; packageKind?: string | null }>;
  /** Children rows (at most `max`) when the session takes children. */
  kids: { max: number } | null;
  /** Other adults (R54): at most `max`; `sharedBeds` of them may share the owner's bed on nights (R13). */
  companions: { max: number; sharedBeds: number } | null;
  extras: Array<{ productId: string; name: string; priceCents: number; price: string; kinds: string[] }>;
  session: BookFormSession;
  moreSessions: BookFormSession[];
  emergency: boolean;
  /** Ask the emergency contact as soon as a night is added (required for a guest). */
  emergencyIfNight: boolean;
  terms: { href: string | null } | null;
  labels: GuestBookLabels;
};

const LEGEND = "font-display mb-1 text-xl";
const OPTION =
  "flex min-h-11 cursor-pointer items-start gap-3 rounded-2xl border-2 border-border bg-card p-4 transition hover:border-[#212842]/40 has-[:checked]:border-[#212842] has-[:checked]:bg-[#fffaef]";
const INPUT =
  "h-12 w-full rounded-xl border border-input bg-card px-4 text-base outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40 aria-[invalid=true]:border-destructive";
const SECTION = "rounded-2xl border border-border p-5";
const SUMMARY = "cursor-pointer font-display text-xl";
const ROUND =
  "grid size-10 place-items-center rounded-full border border-border bg-card text-lg font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-40";

const INITIAL: GuestBookState = { error: null, fields: [], values: {}, n: 0 };
const MAX_EXTRA = 10;

export function GuestBookForm(p: GuestBookFormProps) {
  const [state, formAction, pending] = useActionState(p.action, INITIAL);
  const v = (name: string) => state.values[name] ?? "";
  const bad = (name: string) => (state.fields.includes(name) ? true : undefined);
  const errId = "guest-book-error";
  const formRef = useRef<HTMLFormElement>(null);
  // What the running total and the conditional fields read: the form's current values (after a
  // server answer, the values it returned).
  const [typed, setTyped] = useState<{ n: number; values: Record<string, string> }>({ n: state.n, values: state.values });
  const snap = typed.n === state.n ? typed.values : state.values;
  const read = () => {
    if (!formRef.current) return;
    const out: Record<string, string> = {};
    for (const [k, x] of new FormData(formRef.current).entries()) if (typeof x === "string") out[k] = x;
    setTyped({ n: state.n, values: out });
  };
  const companionsMax = p.companions?.max ?? 0;
  const initialCompanions = Array.from({ length: companionsMax }, (_, i) => i).filter((i) => v(`companions.${i}.firstName`) || v(`companions.${i}.lastName`)).length;
  const [companionCount, setCompanionCount] = useState(initialCompanions);
  const [extras, setExtras] = useState<Record<string, number>>(() => Object.fromEntries(p.extras.map((e) => [e.productId, Number(v(`extras.${e.productId}`)) || 0])));
  const utmRef = useRef<HTMLInputElement>(null);

  // Campaign links (Google Business Profile, Instagram, Facebook): the visit's stored UTM (after
  // analytics consent), else the current URL's when this is the landing page.
  useEffect(() => {
    const stored = readStoredUtm()?.utm;
    const found = stored && Object.keys(stored).length ? stored : utmFromSearch(window.location.search);
    if (utmRef.current) utmRef.current.value = Object.keys(found).length ? JSON.stringify(found) : "";
  }, [state.n]);

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

  // The booking as chosen right now.
  const chosen = [p.session, ...p.moreSessions.filter((s) => snap[`more.${s.sessionId}`] === "on")];
  const hasNight = chosen.some((s) => s.kind === "night");
  const kinds = new Set(chosen.map((s) => s.kind));
  const visibleExtras = p.extras.filter((e) => e.kinds.length === 0 || e.kinds.some((k) => kinds.has(k as BookFormSession["kind"])));
  const kidAges = kidRows.map((i) => (snap[`kids.${i}.firstName`]?.trim() ? snap[`kids.${i}.ageGroup`] : "")).filter((a) => a === "child" || a === "youth");
  const pay = p.payOptions.find((o) => o.value === (snap.pay ?? checkedPay));
  const ownSeatFree = (s: BookFormSession) => pay?.value === "credit" || (!!pay?.packageKind && pay.packageKind === s.kind);
  const fmt = (cents: number) => new Intl.NumberFormat(p.locale, { style: "currency", currency: "EUR" }).format(cents / 100);
  let total = pay?.packageCents ?? 0;
  for (const s of chosen) {
    const seat = s.priceCents ?? 0;
    total += (ownSeatFree(s) ? 0 : seat) + seat * companionCount;
    if (s.childrenAllowed) total += kidAges.filter((a) => a === "youth").length * (s.youthCents ?? 0);
  }
  for (const e of visibleExtras) total += e.priceCents * (extras[e.productId] ?? 0);
  const seatsPer = (s: BookFormSession) => 1 + companionCount + (s.childrenAllowed ? kidAges.length : 0);
  const kindLabel = (k: BookFormSession["kind"]) => (k === "night" ? p.labels.kindNight : k === "day" ? p.labels.kindDay : "");

  const moreByDay = new Map<string, BookFormSession[]>();
  for (const s of p.moreSessions) moreByDay.set(s.day, [...(moreByDay.get(s.day) ?? []), s]);

  return (
    <form key={state.n} ref={formRef} action={formAction} onChange={read} className="grid gap-8" data-testid="guest-book-form">
      <input type="hidden" name="clientKey" value={p.clientKey} />
      <input ref={utmRef} type="hidden" name="utm" defaultValue="" />
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

      {p.companions ? (
        <details open={companionCount > 0} className={SECTION} data-testid="companions">
          <summary className={SUMMARY}>{p.labels.companionsTitle}</summary>
          <p className="mt-2 text-sm text-muted-foreground">{p.labels.companionsBody}</p>
          <div className="mt-4 grid gap-5">
            {Array.from({ length: companionCount }, (_, i) => (
              <fieldset key={i} className="grid gap-3 border-t border-border pt-4 first:border-t-0 first:pt-0" data-testid={`companion-${i}`}>
                <legend className="text-sm font-semibold">{p.labels.companion.replace("{n}", String(i + 2))}</legend>
                <div className="grid gap-3 sm:grid-cols-2">
                  {text(`companions.${i}.firstName`, p.labels.firstName, { autoComplete: "off" })}
                  {text(`companions.${i}.lastName`, p.labels.lastName, { autoComplete: "off" })}
                </div>
                {text(`companions.${i}.email`, p.labels.companionEmail, { type: "email", maxLength: 254, required: false })}
                {hasNight && p.companions!.sharedBeds > 0 ? (
                  <label className="flex min-h-11 items-center gap-3 text-sm font-medium">
                    <input type="checkbox" name={`companions.${i}.sharesBed`} defaultChecked={v(`companions.${i}.sharesBed`) === "on"} className="size-5 accent-[#212842]" />
                    {p.labels.sharesBed}
                  </label>
                ) : null}
              </fieldset>
            ))}
            <div className="flex flex-wrap gap-3">
              {companionCount < companionsMax ? (
                <button type="button" onClick={() => setCompanionCount((n) => n + 1)} className="rounded-full border border-[#212842] px-5 py-2 text-sm font-semibold" data-testid="add-companion">
                  + {p.labels.addCompanion}
                </button>
              ) : null}
              {companionCount > 0 ? (
                <button type="button" onClick={() => setCompanionCount((n) => n - 1)} className="rounded-full px-5 py-2 text-sm text-muted-foreground underline underline-offset-4">
                  {p.labels.removeCompanion}
                </button>
              ) : null}
            </div>
          </div>
        </details>
      ) : null}

      {p.kids ? (
        <details open={kidsOpen} className={SECTION} data-testid="kids">
          <summary className={SUMMARY}>{p.labels.kidsTitle}</summary>
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

      {p.moreSessions.length ? (
        <details open={chosen.length > 1} className={SECTION} data-testid="more-sessions">
          <summary className={SUMMARY}>{p.labels.moreTitle}</summary>
          <p className="mt-2 text-sm text-muted-foreground">{p.labels.moreBody}</p>
          <div className="mt-4 grid gap-4">
            {[...moreByDay.entries()].map(([day, slots]) => (
              <fieldset key={day} className="grid gap-2">
                <legend className="mb-1 text-sm font-semibold first-letter:uppercase">{day}</legend>
                <div className="flex flex-wrap gap-2">
                  {slots.map((s) => (
                    <label
                      key={s.sessionId}
                      className="flex min-h-11 cursor-pointer items-center gap-2 rounded-full border border-border bg-card px-4 py-2 text-sm has-[:checked]:border-[#212842] has-[:checked]:bg-[#fffaef]"
                    >
                      <input type="checkbox" name={`more.${s.sessionId}`} defaultChecked={v(`more.${s.sessionId}`) === "on"} className="size-4 accent-[#212842]" />
                      <span>
                        {s.kind === "night" ? "☾" : "☀"} {s.time}
                        <span className="sr-only"> {kindLabel(s.kind)}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>
            ))}
          </div>
        </details>
      ) : null}

      {visibleExtras.length ? (
        <details open={visibleExtras.some((e) => (extras[e.productId] ?? 0) > 0)} className={SECTION} data-testid="extras">
          <summary className={SUMMARY}>{p.labels.extrasTitle}</summary>
          <p className="mt-2 text-sm text-muted-foreground">{p.labels.extrasBody}</p>
          <ul className="mt-4 grid gap-3">
            {visibleExtras.map((e) => {
              const qty = extras[e.productId] ?? 0;
              const set = (n: number) => setExtras((x) => ({ ...x, [e.productId]: Math.max(0, Math.min(MAX_EXTRA, n)) }));
              return (
                <li key={e.productId} className="flex items-center justify-between gap-4" data-testid={`extra-${e.productId}`}>
                  <span className="grid">
                    <span className="font-medium">{e.name}</span>
                    <span className="text-sm text-muted-foreground tabular-nums">{e.price}</span>
                  </span>
                  <span className="flex items-center gap-3">
                    <button type="button" className={ROUND} onClick={() => set(qty - 1)} disabled={qty === 0} aria-label={p.labels.fewer.replace("{name}", e.name)}>
                      −
                    </button>
                    <output aria-live="polite" className="w-6 text-center font-semibold tabular-nums">
                      {qty}
                    </output>
                    <button type="button" className={ROUND} onClick={() => set(qty + 1)} disabled={qty >= MAX_EXTRA} aria-label={p.labels.more.replace("{name}", e.name)}>
                      +
                    </button>
                    <input type="hidden" name={`extras.${e.productId}`} value={qty} />
                  </span>
                </li>
              );
            })}
          </ul>
        </details>
      ) : null}

      {p.emergency || (p.emergencyIfNight && hasNight) ? (
        <fieldset className="grid gap-4 sm:grid-cols-2" data-testid="emergency-fields">
          <legend className={`${LEGEND} sm:col-span-2`}>{p.labels.emergencyTitle}</legend>
          {text("emergency.name", p.labels.emergencyName, { maxLength: 200, required: p.emergency || !p.signedIn })}
          {text("emergency.phone", p.labels.emergencyPhone, { type: "tel", maxLength: 40, minLength: 3, required: p.emergency || !p.signedIn })}
        </fieldset>
      ) : null}

      <details open={!!v("code")} className={SECTION} data-testid="code">
        <summary className={SUMMARY}>{p.labels.codeTitle}</summary>
        <label className="mt-4 grid gap-1.5 text-sm font-medium">
          {p.labels.codeLabel}
          <input
            name="code"
            maxLength={64}
            autoComplete="off"
            defaultValue={v("code")}
            aria-invalid={bad("code")}
            aria-describedby={bad("code") ? errId : "code-hint"}
            className={`${INPUT} uppercase`}
          />
        </label>
        <p id="code-hint" className="mt-2 text-sm text-muted-foreground">
          {p.labels.codeHint}
        </p>
      </details>

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

      <section aria-labelledby="book-summary" className="grid gap-3 rounded-2xl bg-[#fffaef] p-5" data-testid="book-summary">
        <h3 id="book-summary" className="font-semibold">
          {p.labels.summaryTitle}
        </h3>
        <ul className="grid gap-1 text-sm">
          {chosen.map((s) => (
            <li key={s.sessionId} className="flex justify-between gap-3">
              <span className="first-letter:uppercase">
                {kindLabel(s.kind) ? `${kindLabel(s.kind)} · ` : ""}
                {s.day} · {s.time}
              </span>
              <span className="shrink-0 text-muted-foreground">{p.labels.seats.replace("{n}", String(seatsPer(s)))}</span>
            </li>
          ))}
          {visibleExtras
            .filter((e) => (extras[e.productId] ?? 0) > 0)
            .map((e) => (
              <li key={e.productId} className="flex justify-between gap-3">
                <span>
                  {extras[e.productId]} × {e.name}
                </span>
              </li>
            ))}
        </ul>
        <p className="flex items-baseline justify-between gap-3 border-t border-[#212842]/15 pt-3">
          <span className="font-semibold">{p.labels.total}</span>
          <span className="text-xl font-semibold tabular-nums" data-testid="book-total" suppressHydrationWarning>
            {fmt(total)}
          </span>
        </p>
        <p className="text-xs text-muted-foreground">{p.labels.totalHint}</p>
      </section>

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
