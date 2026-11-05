"use client";
/**
 * The webinar registration form (webinar spec 5.3, rules 14 and 18). Two variants:
 *
 * - `site`: email, first name, optional last name, the two optional unticked consent boxes
 *   (`events`, `newsletter`) with their versioned wording, a hidden honeypot and the privacy
 *   notice link under the button. Posts JSON to `/api/public/webinars/<slug>/register` with the
 *   visit's stored UTM; the route always answers 202, so the form always says "Check your inbox".
 * - `portal`: one click for a signed-in customer (the consent boxes are shown once), calling the
 *   `registerForWebinar` action; on success it shows the confirmation and refreshes the page.
 *
 * Every text comes from the server as a prop. Errors are announced in a polite live region and
 * never steal focus; the button is disabled while the request runs.
 */
import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent } from "react";
import { readStoredUtm } from "@beam/core/site";
import { Button, FormField, Input } from "@beam/ui";
import { registerForWebinar } from "../actions";

export type RegistrationFormLabels = {
  email: string;
  firstName: string;
  lastName: string;
  consentLegend: string;
  consentEvents: string;
  consentNewsletter: string;
  consentHint: string;
  privacyBefore: string;
  privacyLink: string;
  submit: string;
  submitPortal: string;
  submitting: string;
  successTitle: string;
  successBody: string;
  successPortal: string;
  errors: Record<string, string>;
};

type Locale = "nl-BE" | "fr-BE" | "en";

export type RegistrationFormProps = {
  variant: "site" | "portal";
  webinarId: string;
  slug: string;
  locale: Locale;
  wordingVersion: string;
  privacyHref: string;
  labels: RegistrationFormLabels;
  /** Portal: whether the consent boxes are offered (shown once, until the person answered). */
  showConsents?: boolean;
};

const checkboxClass = "mt-1 size-4 shrink-0 rounded border border-input accent-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

export function RegistrationForm({ variant, webinarId, slug, locale, wordingVersion, privacyHref, labels, showConsents = true }: RegistrationFormProps) {
  const router = useRouter();
  const ids = useId();
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const text = (k: string) => {
      const v = form.get(k);
      return typeof v === "string" ? v.trim() : "";
    };
    const consents = { events: form.get("consent_events") === "on", newsletter: form.get("consent_newsletter") === "on" };
    setPending(true);
    setError(null);
    try {
      if (variant === "portal") {
        const res = await registerForWebinar({ webinarId, locale, consents, wordingVersion });
        if (!res.ok) {
          setError(labels.errors[res.error.message] ?? labels.errors[res.error.code] ?? labels.errors.internal ?? "");
          return;
        }
        setDone(true);
        router.refresh();
        return;
      }
      const res = await fetch(`/api/public/webinars/${encodeURIComponent(slug)}/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: text("email"),
          firstName: text("firstName"),
          ...(text("lastName") ? { lastName: text("lastName") } : {}),
          locale,
          consents,
          wordingVersion,
          utm: readStoredUtm()?.utm ?? {},
          website: text("website"),
        }),
      });
      if (res.status === 202 || res.ok) {
        setDone(true);
        return;
      }
      const body = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
      const code = body?.error?.message ?? body?.error?.code ?? "internal";
      setError(labels.errors[code] ?? labels.errors[body?.error?.code ?? ""] ?? labels.errors.internal ?? "");
    } catch {
      setError(labels.errors.internal ?? "");
    } finally {
      setPending(false);
    }
  }

  if (done) {
    return (
      <div role="status" className="rounded-md border border-border bg-muted/40 p-4">
        <p className="font-semibold">{labels.successTitle}</p>
        <p className="text-sm">{variant === "portal" ? labels.successPortal : labels.successBody}</p>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate={false} aria-describedby={`${ids}-privacy`}>
      {variant === "site" ? (
        <>
          <FormField label={labels.email} required>
            <Input name="email" type="email" autoComplete="email" required maxLength={254} />
          </FormField>
          <FormField label={labels.firstName} required>
            <Input name="firstName" autoComplete="given-name" required maxLength={100} />
          </FormField>
          <FormField label={labels.lastName}>
            <Input name="lastName" autoComplete="family-name" maxLength={100} />
          </FormField>
          {/* Honeypot: hidden from people and assistive technology; bots fill it. */}
          <div aria-hidden="true" className="absolute -left-[10000px] h-px w-px overflow-hidden">
            <label>
              Website
              <input name="website" type="text" tabIndex={-1} autoComplete="off" defaultValue="" />
            </label>
          </div>
        </>
      ) : null}
      {showConsents ? (
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">{labels.consentLegend}</legend>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" name="consent_events" className={checkboxClass} />
            <span>{labels.consentEvents}</span>
          </label>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" name="consent_newsletter" className={checkboxClass} />
            <span>{labels.consentNewsletter}</span>
          </label>
          <p className="text-xs text-muted-foreground">{labels.consentHint}</p>
        </fieldset>
      ) : null}
      <div aria-live="polite">
        {error ? (
          <p className="rounded-md border border-destructive p-3 text-sm" data-testid="webinar-register-error">
            {error}
          </p>
        ) : null}
      </div>
      <Button type="submit" disabled={pending}>
        {pending ? labels.submitting : variant === "portal" ? labels.submitPortal : labels.submit}
      </Button>
      <p id={`${ids}-privacy`} className="text-xs text-muted-foreground">
        {labels.privacyBefore}{" "}
        <a href={privacyHref} className="underline underline-offset-2">
          {labels.privacyLink}
        </a>
      </p>
    </form>
  );
}
