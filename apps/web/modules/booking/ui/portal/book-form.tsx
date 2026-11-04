/**
 * The booking form of `/[locale]/account/book/[sessionId]` (booking spec 5.2, R16-R18, R28,
 * R54-R56, R62, R62b): payment choice (package credits with "4 sessions remaining", a single
 * session at its quoted price with a promotion code, or free), guests, the cancellation policy
 * and no-withdrawal notice, the terms checkbox when the person has not accepted the current
 * terms, the health declaration notice and the night emergency contact. A plain `<form>` posting
 * the page's server action, so it works without client JavaScript; `clientKey` makes a double
 * submit land on the same order (edge case 2). The error from a `conflict` is announced with
 * `role="alert"` and linked to its field. Every text comes from the page.
 */
import Link from "next/link";
import type { Route } from "next";
import { Button, Input, Label } from "@beam/ui";
import { GuestFields, type GuestFieldsLabels } from "./guest-fields";
import { PolicyNote } from "./policy-note";

export type PayOption = { value: "credit" | "order" | "free"; label: string; hint: string | null };

export type BookFormLabels = {
  payment: string;
  promoCode: string;
  acceptTerms: string;
  readTerms: string;
  healthLink: string;
  emergencyTitle: string;
  emergencyName: string;
  emergencyPhone: string;
  emergencyRelation: string;
  submit: string;
  noPayOption: string;
  guests: GuestFieldsLabels;
};

export type BookFormProps = {
  action: (formData: FormData) => Promise<void>;
  clientKey: string;
  payOptions: PayOption[];
  showPromo: boolean;
  guests: { max: number; isNight: boolean; payOptions: ReadonlyArray<"guest" | "order"> } | null;
  terms: { required: boolean; href: string | null };
  health: { message: string; href: string | null } | null;
  emergency: boolean;
  policy: { text: string; notice: string };
  /** The translated error and, when known, the field it belongs to. */
  error: { message: string; field: "terms" | "emergency" | "payment" | null } | null;
  labels: BookFormLabels;
};

export function BookForm(p: BookFormProps) {
  const errId = "book-form-error";
  const errFor = (f: NonNullable<BookFormProps["error"]>["field"]) => (p.error && p.error.field === f ? errId : undefined);
  if (p.payOptions.length === 0) {
    return (
      <p className="rounded-md border p-3" data-testid="no-pay-option">
        {p.labels.noPayOption}
      </p>
    );
  }
  return (
    <form action={p.action} className="space-y-5" data-testid="book-form" noValidate={false}>
      <input type="hidden" name="clientKey" value={p.clientKey} />
      {p.error ? (
        <p id={errId} role="alert" className="rounded-md border border-destructive p-3 text-sm" data-testid="book-error">
          {p.error.message}
        </p>
      ) : null}

      <fieldset className="space-y-2" aria-describedby={errFor("payment")}>
        <legend className="font-medium">{p.labels.payment}</legend>
        {p.payOptions.map((o, i) => (
          <label key={o.value} className="flex min-h-11 items-start gap-3 rounded-md border p-3">
            <input type="radio" name="payWith" value={o.value} defaultChecked={i === 0} className="mt-1 size-5" data-testid={`pay-${o.value}`} />
            <span className="flex flex-col">
              <span>{o.label}</span>
              {o.hint ? <span className="text-sm text-muted-foreground">{o.hint}</span> : null}
            </span>
          </label>
        ))}
        {p.showPromo ? (
          <div className="grid gap-1 pt-1">
            <Label htmlFor="promoCode">{p.labels.promoCode}</Label>
            <Input id="promoCode" name="promoCode" autoComplete="off" maxLength={64} className="max-w-xs" />
          </div>
        ) : null}
      </fieldset>

      {p.guests ? <GuestFields labels={p.labels.guests} max={p.guests.max} isNight={p.guests.isNight} payOptions={p.guests.payOptions} /> : null}

      {p.emergency ? (
        <fieldset className="grid gap-3 sm:grid-cols-2" aria-describedby={errFor("emergency")} data-testid="emergency-fields">
          <legend className="font-medium sm:col-span-2">{p.labels.emergencyTitle}</legend>
          <div className="grid gap-1">
            <Label htmlFor="ec-name">{p.labels.emergencyName}</Label>
            <Input id="ec-name" name="emergency.name" required autoComplete="off" maxLength={200} />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="ec-phone">{p.labels.emergencyPhone}</Label>
            <Input id="ec-phone" name="emergency.phone" type="tel" required autoComplete="off" maxLength={40} />
          </div>
          <div className="grid gap-1 sm:col-span-2">
            <Label htmlFor="ec-relation">{p.labels.emergencyRelation}</Label>
            <Input id="ec-relation" name="emergency.relation" autoComplete="off" maxLength={100} />
          </div>
        </fieldset>
      ) : null}

      {p.health ? (
        <p className="rounded-md border border-warning bg-warning/10 p-3 text-sm" data-testid="health-notice">
          {p.health.message}{" "}
          {p.health.href ? (
            <Link href={p.health.href as Route} className="underline">
              {p.labels.healthLink}
            </Link>
          ) : null}
        </p>
      ) : null}

      <PolicyNote policy={p.policy.text} notice={p.policy.notice} />

      {p.terms.required ? (
        <div className="space-y-1">
          <label className="flex min-h-11 items-center gap-3">
            <input type="checkbox" name="acceptTerms" required className="size-5" aria-describedby={errFor("terms")} data-testid="accept-terms" />
            <span>{p.labels.acceptTerms}</span>
          </label>
          {p.terms.href ? (
            <a href={p.terms.href} target="_blank" rel="noreferrer" className="text-sm underline">
              {p.labels.readTerms}
            </a>
          ) : null}
        </div>
      ) : null}

      <Button type="submit" className="min-h-11" data-testid="book-submit">
        {p.labels.submit}
      </Button>
    </form>
  );
}
