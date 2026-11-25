"use client";
/**
 * The portal's first-sign-in onboarding (owner requirements item 10): one question per screen,
 * big inputs, a progress bar, "Skip" and "Later" on every screen and Enter to continue. Every
 * screen saves on its own through `saveMyOnboardingStep`, so the client can leave at any point.
 * Marketing purposes start from the client's current consent (unticked for a new client). Every
 * string is a prop.
 */
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { normaliseVat, ONBOARDING_STEPS, type MarketingPurpose, type OnboardingStep } from "@beam/core/crm";
import { markMyOnboarding, saveMyOnboardingStep } from "../portal/actions";

type Option = { value: string; label: string };
type Address = { street?: string; number?: string; postal_code?: string; city?: string; country: string };

export type OnboardingFlowLabels = {
  title: string;
  intro: string;
  /** `crm.portal.onboarding.progress` with `{step}` and `{total}` left in. */
  progress: string;
  continue: string;
  skip: string;
  later: string;
  saving: string;
  error: string;
  enterHint: string;
  emergencyTitle: string;
  emergencyBody: string;
  emergencyName: string;
  emergencyPhone: string;
  emergencyRelation: string;
  emergencyIncomplete: string;
  communicationTitle: string;
  communicationBody: string;
  communicationAlways: string;
  channel: string;
  confirmSent: string;
  suppressed: string;
  companyTitle: string;
  companyBody: string;
  vat: string;
  vatHint: string;
  vatInvalid: string;
  companyName: string;
  companyNameRequired: string;
  /** `crm.portal.onboarding.company_linked` with `{name}` and `{vat}` left in. */
  companyLinked: string;
  street: string;
  number: string;
  postalCode: string;
  city: string;
  country: string;
  aboutTitle: string;
  aboutBody: string;
  birthOn: string;
  language: string;
  doneTitle: string;
  doneBody: string;
  doneHome: string;
  doneProfile: string;
};

export type OnboardingFlowProps = {
  /** The first step without an answer; `null` shows the closing screen. */
  start: OnboardingStep | null;
  homeHref: string;
  profileHref: string;
  prefill: {
    emergency: { name: string; phone: string; relation?: string } | null;
    purposes: Record<MarketingPurpose, boolean>;
    suppressedAll: boolean;
    channel: string | null;
    company: { name: string; vatNumber: string; address: Address | null } | null;
    birthOn: string | null;
    locale: string;
  };
  purposes: Array<{ purpose: MarketingPurpose; label: string; wording: string | null }>;
  channels: Option[];
  locales: Option[];
  labels: OnboardingFlowLabels;
};

const inputClass =
  "h-14 w-full rounded-2xl border border-[#212842]/20 bg-white px-4 text-lg text-[#212842] placeholder:text-[#212842]/40 focus-visible:border-[#d1a64a] focus-visible:ring-4 focus-visible:ring-[#d1a64a]/30 focus-visible:outline-none";
const pill = "inline-flex h-12 items-center justify-center rounded-full px-6 text-base font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#212842]";

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="grid gap-2 text-sm font-medium text-[#212842]/80">
      {label}
      {children}
    </label>
  );
}

const value = (fd: FormData, key: string) => {
  const v = fd.get(key);
  return typeof v === "string" ? v.trim() : "";
};

export function OnboardingFlow({ start, homeHref, profileHref, prefill, purposes, channels, locales, labels }: OnboardingFlowProps) {
  const router = useRouter();
  const [index, setIndex] = useState(start ? ONBOARDING_STEPS.indexOf(start) : ONBOARDING_STEPS.length);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const seen = useRef<Promise<unknown> | null>(null);
  const step = ONBOARDING_STEPS[index] ?? null;
  const total = ONBOARDING_STEPS.length;

  useEffect(() => {
    seen.current ??= markMyOnboarding({ event: "seen" });
  }, []);

  async function save(input: Parameters<typeof saveMyOnboardingStep>[0]) {
    setBusy(true);
    setError(null);
    const result = await saveMyOnboardingStep(input);
    setBusy(false);
    if (!result.ok) {
      setError(result.error.fields?.vatNumber === "vat_invalid" ? labels.vatInvalid : labels.error);
      return;
    }
    const outcomes = Object.values(result.data.skipped ?? {});
    setNotice(outcomes.includes("needs_confirmation") ? labels.confirmSent : null);
    setIndex((i) => i + 1);
  }

  async function later() {
    await seen.current;
    router.push(homeHref as never);
  }

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    if (step === "emergency") {
      const name = value(fd, "name");
      const phone = value(fd, "phone");
      const relation = value(fd, "relation");
      if (!name && !phone) return void save({ step });
      if (!name || phone.length < 6) return setError(labels.emergencyIncomplete);
      return void save({ step, answer: { name, phone, ...(relation ? { relation } : {}) } });
    }
    if (step === "communication") {
      const channel = value(fd, "channel");
      const ticked = (p: MarketingPurpose) => fd.get(`purpose_${p}`) === "on";
      return void save({
        step,
        answer: {
          newsletter: ticked("newsletter"),
          events: ticked("events"),
          member_comms: ticked("member_comms"),
          b2b: ticked("b2b"),
          ...(channel === "email" || channel === "phone" || channel === "whatsapp" ? { preferredChannel: channel } : {}),
        },
      });
    }
    if (step === "company") {
      const vat = value(fd, "vat");
      const name = value(fd, "company_name");
      if (!vat && !name) return void save({ step });
      if (!normaliseVat(vat)) return setError(labels.vatInvalid);
      if (!name) return setError(labels.companyNameRequired);
      const address: Address = { street: value(fd, "street"), number: value(fd, "number"), postal_code: value(fd, "postal_code"), city: value(fd, "city"), country: (value(fd, "country") || "BE").toUpperCase().slice(0, 2) };
      const hasAddress = !!(address.street || address.postal_code || address.city);
      return void save({ step, answer: { vatNumber: vat, companyName: name, ...(hasAddress ? { address } : {}) } });
    }
    if (step === "about") {
      const birthOn = value(fd, "birth_on");
      const locale = value(fd, "locale");
      const changedLocale = locale && locale !== prefill.locale ? (locale as "nl-BE" | "fr-BE" | "en") : undefined;
      if (!birthOn && !changedLocale) return void save({ step: "about", answer: {} });
      return void save({ step: "about", answer: { ...(birthOn ? { birthOn } : {}), ...(changedLocale ? { locale: changedLocale } : {}) } });
    }
  }

  /** Enter on a checkbox, radio or select continues too (text inputs submit natively). */
  function onKeyDown(e: KeyboardEvent<HTMLFormElement>) {
    const target = e.target as HTMLElement;
    if (e.key !== "Enter" || target.tagName === "BUTTON" || target.tagName === "TEXTAREA") return;
    if (target instanceof HTMLInputElement && !["checkbox", "radio"].includes(target.type)) return;
    e.preventDefault();
    e.currentTarget.requestSubmit();
  }

  if (!step) {
    return (
      <section className="mx-auto grid w-full max-w-xl gap-6 rounded-[2rem] bg-[#fffaef] p-6 text-[#212842] sm:p-10" aria-labelledby="onboarding-done">
        <h1 id="onboarding-done" className="font-display text-4xl">
          {labels.doneTitle}
        </h1>
        {notice ? <p role="status">{notice}</p> : null}
        <p className="text-lg text-[#212842]/80">{labels.doneBody}</p>
        <div className="flex flex-col gap-3 sm:flex-row">
          <a href={homeHref} className={`site-gold ${pill} text-[#212842]`}>
            {labels.doneHome}
          </a>
          <a href={profileHref} className={`${pill} ring-1 ring-[#212842]/20`}>
            {labels.doneProfile}
          </a>
        </div>
      </section>
    );
  }

  const titles: Record<OnboardingStep, [string, string]> = {
    emergency: [labels.emergencyTitle, labels.emergencyBody],
    communication: [labels.communicationTitle, labels.communicationBody],
    company: [labels.companyTitle, labels.companyBody],
    about: [labels.aboutTitle, labels.aboutBody],
  };
  const [title, body] = titles[step];
  const c = prefill.company;
  const linked = c ? labels.companyLinked.replace("{name}", c.name).replace("{vat}", c.vatNumber) : null;

  return (
    <section className="mx-auto grid w-full max-w-xl gap-6" aria-labelledby="onboarding-title">
      <header className="grid gap-3">
        <p className="text-xs font-semibold tracking-[0.25em] text-[#a0621e] uppercase">{labels.title}</p>
        {index === 0 ? <p className="text-[#212842]/70">{labels.intro}</p> : null}
        <div
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={index + 1}
          aria-valuetext={labels.progress.replace("{step}", String(index + 1)).replace("{total}", String(total))}
          className="h-2 overflow-hidden rounded-full bg-[#212842]/10"
        >
          <div className="h-full rounded-full bg-[#d1a64a] transition-all duration-500" style={{ width: `${((index + 1) / total) * 100}%` }} />
        </div>
        <p className="text-sm text-[#212842]/60">{labels.progress.replace("{step}", String(index + 1)).replace("{total}", String(total))}</p>
      </header>

      <form key={step} onSubmit={submit} onKeyDown={onKeyDown} noValidate className="grid gap-6 rounded-[2rem] bg-[#fffaef] p-6 text-[#212842] shadow-sm sm:p-10" data-onboarding-step={step}>
        <div className="grid gap-2">
          <h1 id="onboarding-title" className="font-display text-3xl sm:text-4xl">
            {title}
          </h1>
          <p className="text-[#212842]/75">{body}</p>
        </div>
        {notice ? (
          <p role="status" className="rounded-2xl bg-[#f4ead3] px-4 py-3 text-sm">
            {notice}
          </p>
        ) : null}

        {step === "emergency" ? (
          <div className="grid gap-4">
            <Field label={labels.emergencyName}>
              <input name="name" autoFocus autoComplete="off" maxLength={100} defaultValue={prefill.emergency?.name ?? ""} className={inputClass} />
            </Field>
            <Field label={labels.emergencyPhone}>
              <input name="phone" type="tel" inputMode="tel" autoComplete="off" maxLength={40} defaultValue={prefill.emergency?.phone ?? ""} className={inputClass} />
            </Field>
            <Field label={labels.emergencyRelation}>
              <input name="relation" maxLength={100} defaultValue={prefill.emergency?.relation ?? ""} className={inputClass} />
            </Field>
          </div>
        ) : null}

        {step === "communication" ? (
          <div className="grid gap-5">
            {prefill.suppressedAll ? <p className="rounded-2xl bg-[#f4ead3] px-4 py-3 text-sm">{labels.suppressed}</p> : null}
            <fieldset className="grid gap-3">
              {purposes.map((p, i) => (
                <label key={p.purpose} className="flex cursor-pointer items-start gap-4 rounded-2xl border border-[#212842]/15 bg-white p-4 has-[:checked]:border-[#d1a64a] has-[:checked]:bg-[#f4ead3]/60">
                  <input
                    type="checkbox"
                    name={`purpose_${p.purpose}`}
                    defaultChecked={prefill.purposes[p.purpose]}
                    disabled={prefill.suppressedAll}
                    autoFocus={i === 0}
                    className="mt-1 size-6 shrink-0 accent-[#212842]"
                  />
                  <span className="grid gap-1">
                    <span className="text-lg font-medium">{p.label}</span>
                    {p.wording ? <span className="text-sm text-[#212842]/70">{p.wording}</span> : null}
                  </span>
                </label>
              ))}
            </fieldset>
            <p className="text-sm text-[#212842]/70">{labels.communicationAlways}</p>
            <fieldset className="grid gap-3">
              <legend className="mb-2 text-sm font-medium text-[#212842]/80">{labels.channel}</legend>
              <div className="flex flex-wrap gap-2">
                {channels.map((ch) => (
                  <label key={ch.value} className="cursor-pointer rounded-full border border-[#212842]/20 bg-white px-5 py-3 text-base has-[:checked]:border-[#212842] has-[:checked]:bg-[#212842] has-[:checked]:text-[#fffaef] has-[:focus-visible]:ring-4 has-[:focus-visible]:ring-[#d1a64a]/40">
                    <input type="radio" name="channel" value={ch.value} defaultChecked={prefill.channel === ch.value} className="sr-only" />
                    {ch.label}
                  </label>
                ))}
              </div>
            </fieldset>
          </div>
        ) : null}

        {step === "company" ? (
          <div className="grid gap-4">
            {linked ? <p className="rounded-2xl bg-[#f4ead3] px-4 py-3 text-sm">{linked}</p> : null}
            <Field label={labels.vat}>
              <input name="vat" autoFocus autoCapitalize="characters" autoComplete="off" placeholder={labels.vatHint} maxLength={30} defaultValue={c?.vatNumber ?? ""} className={inputClass} />
            </Field>
            <Field label={labels.companyName}>
              <input name="company_name" autoComplete="organization" maxLength={200} defaultValue={c?.name ?? ""} className={inputClass} />
            </Field>
            <div className="grid gap-4 sm:grid-cols-[1fr_7rem]">
              <Field label={labels.street}>
                <input name="street" autoComplete="address-line1" maxLength={200} defaultValue={c?.address?.street ?? ""} className={inputClass} />
              </Field>
              <Field label={labels.number}>
                <input name="number" maxLength={20} defaultValue={c?.address?.number ?? ""} className={inputClass} />
              </Field>
            </div>
            <div className="grid gap-4 sm:grid-cols-[8rem_1fr_6rem]">
              <Field label={labels.postalCode}>
                <input name="postal_code" autoComplete="postal-code" inputMode="numeric" maxLength={20} defaultValue={c?.address?.postal_code ?? ""} className={inputClass} />
              </Field>
              <Field label={labels.city}>
                <input name="city" autoComplete="address-level2" maxLength={100} defaultValue={c?.address?.city ?? ""} className={inputClass} />
              </Field>
              <Field label={labels.country}>
                <input name="country" autoComplete="country" maxLength={2} defaultValue={c?.address?.country ?? "BE"} className={inputClass} />
              </Field>
            </div>
          </div>
        ) : null}

        {step === "about" ? (
          <div className="grid gap-4">
            <Field label={labels.birthOn}>
              <input name="birth_on" type="date" autoFocus autoComplete="bday" defaultValue={prefill.birthOn ?? ""} className={inputClass} />
            </Field>
            <Field label={labels.language}>
              <select name="locale" defaultValue={prefill.locale} className={inputClass}>
                {locales.map((l) => (
                  <option key={l.value} value={l.value}>
                    {l.label}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        ) : null}

        <div aria-live="polite">
          {error ? (
            <p role="alert" className="rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-800">
              {error}
            </p>
          ) : null}
        </div>

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <button type="submit" disabled={busy} className={`site-gold ${pill} text-[#212842] disabled:opacity-60`}>
            {busy ? labels.saving : labels.continue}
          </button>
          <span className="hidden text-sm text-[#212842]/50 sm:inline">{labels.enterHint}</span>
          <div className="flex gap-3 sm:ml-auto">
            <button type="button" disabled={busy} onClick={() => void save({ step })} className={`${pill} flex-1 ring-1 ring-[#212842]/20 hover:bg-[#212842]/5`}>
              {labels.skip}
            </button>
            <button type="button" disabled={busy} onClick={() => void later()} className={`${pill} flex-1 text-[#212842]/70 hover:bg-[#212842]/5`}>
              {labels.later}
            </button>
          </div>
        </div>
      </form>
    </section>
  );
}
