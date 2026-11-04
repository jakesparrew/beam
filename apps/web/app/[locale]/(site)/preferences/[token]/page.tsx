import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { Alert, AlertDescription, Button, Input } from "@beam/ui";
import { MARKETING_PURPOSES, type MarketingPurpose } from "@beam/core/crm";
import { localeFromSegment, LOCALES, URL_SEGMENT } from "@beam/core/i18n";
import { getAppDb } from "@/lib/ctx";
import { translator } from "@/lib/i18n";
import { requestFreshPreferenceLink, unsubscribeByToken, updatePreferencesByToken } from "@/modules/crm/consent/actions";
import { getCurrentMarketingWordings, getPreferenceState } from "@/modules/crm/consent/queries";
import { PreferenceSwitches, type PreferenceSwitchesLabels } from "@/modules/crm/ui/preference-switches";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { robots: { index: false, follow: false } };

type Search = { confirm?: string; purpose?: string; done?: string };

const formText = (fd: FormData, key: string): string => {
  const value = fd.get(key);
  return typeof value === "string" ? value.trim() : "";
};

const isPurpose = (v: string | undefined): v is MarketingPurpose => !!v && (MARKETING_PURPOSES as readonly string[]).includes(v);

/**
 * `/[locale]/preferences/[token]` (crm spec 5.3): the token preference centre. Greets with the
 * first-name initial only, one switch per purpose with its wording, the language, and
 * "unsubscribe from all". `?confirm=unsubscribe` shows one confirm button for the token's purpose
 * and `?confirm=resubscribe&purpose=<p>` the confirmation of `crm.confirm_resubscribe`; both are
 * plain form POSTs to server actions, so they work without JavaScript. Page is `noindex`.
 */
export default async function PreferenceCentrePage({ params, searchParams }: { params: Promise<{ locale: string; token: string }>; searchParams: Promise<Search> }) {
  const { locale: segment, token } = await params;
  const locale = localeFromSegment(segment);
  if (!locale) notFound();
  const sp = await searchParams;
  const tr = translator(locale);
  const db = await getAppDb();
  const state = await getPreferenceState(db, token);
  const here = `/${URL_SEGMENT[locale]}/preferences/${encodeURIComponent(token)}`;
  const purposeName = (p: MarketingPurpose | "all") => (p === "all" ? tr("crm.enums.suppression_scope.all") : tr(`crm.enums.consent_purpose.${p}`));

  async function confirmUnsubscribe(fd: FormData) {
    "use server";
    const purpose = formText(fd, "purpose");
    await unsubscribeByToken({ token, ...(purpose === "all" || isPurpose(purpose) ? { purpose } : {}) });
    redirect(`${here}?done=${purpose === "all" ? "unsubscribed_all" : `unsubscribed&purpose=${purpose}`}` as never);
  }

  async function confirmResubscribe(fd: FormData) {
    "use server";
    const purpose = formText(fd, "purpose");
    const current = await getPreferenceState(await getAppDb(), token);
    if (!current || !isPurpose(purpose)) redirect(here as never);
    const result = await updatePreferencesByToken({ token, purposes: { ...current.purposes, [purpose]: true } });
    redirect(`${here}?done=${result.ok ? "saved" : "error"}` as never);
  }

  async function freshLink(fd: FormData) {
    "use server";
    const email = formText(fd, "email");
    const result = await requestFreshPreferenceLink(email ? { email } : { token });
    redirect(`${here}?done=${result.ok ? "fresh" : "fresh_limit"}` as never);
  }

  const freshLinkForm = (withEmail: boolean) => (
    <form action={freshLink} className="grid max-w-md gap-3">
      {withEmail ? (
        <label className="grid gap-1 text-sm font-medium">
          {tr("crm.preferences.fresh_link_email")}
          <Input name="email" type="email" required autoComplete="email" />
        </label>
      ) : null}
      <div>
        <Button type="submit" variant="outline">
          {tr("crm.preferences.fresh_link")}
        </Button>
      </div>
    </form>
  );

  const doneMessage =
    sp.done === "saved"
      ? tr("crm.preferences.saved")
      : sp.done === "unsubscribed" && isPurpose(sp.purpose)
        ? tr("crm.preferences.unsubscribed", { purpose: purposeName(sp.purpose) })
        : sp.done === "unsubscribed_all"
          ? tr("crm.preferences.unsubscribed_all")
          : sp.done === "fresh"
            ? tr("crm.preferences.fresh_link_sent")
            : sp.done === "fresh_limit"
              ? tr("crm.preferences.fresh_link_limit")
              : sp.done === "error"
                ? tr("crm.common.error")
                : null;

  if (!state) {
    return (
      <main className="mx-auto grid max-w-2xl gap-6 px-4 py-10">
        <h1 className="text-2xl font-semibold">{tr("crm.preferences.title")}</h1>
        <div aria-live="polite" role="status">
          {doneMessage ? (
            <Alert>
              <AlertDescription>{doneMessage}</AlertDescription>
            </Alert>
          ) : null}
        </div>
        <p>{tr("crm.preferences.invalid")}</p>
        {freshLinkForm(true)}
      </main>
    );
  }

  const wordings = await getCurrentMarketingWordings(db);
  const labels: PreferenceSwitchesLabels = {
    on: tr("crm.common.switch_on"),
    off: tr("crm.common.switch_off"),
    save: tr("crm.preferences.save"),
    saving: tr("crm.common.saving"),
    saved: tr("crm.preferences.saved"),
    error: tr("crm.common.error"),
    expired: tr("crm.preferences.expired"),
    unsubscribeAll: tr("crm.preferences.unsubscribe_all"),
    unsubscribedAll: tr("crm.preferences.unsubscribed_all"),
    minor: tr("crm.portal.preferences.minor"),
    confirmSent: tr("crm.portal.preferences.confirm_sent"),
    suppressed: tr("crm.preferences.suppressed"),
    alwaysArrive: tr("crm.preferences.always_arrive"),
    language: tr("crm.preferences.language"),
  };
  const confirmPurpose = sp.confirm === "unsubscribe" ? state.confirmPurpose : null;
  const resubscribePurpose = sp.confirm === "resubscribe" && isPurpose(sp.purpose) && state.canEdit && !state.suppressedAll ? sp.purpose : null;

  return (
    <main className="mx-auto grid max-w-2xl gap-6 px-4 py-10">
      <header className="grid gap-2">
        <h1 className="text-2xl font-semibold">{tr("crm.preferences.title")}</h1>
        <p>{state.firstNameInitial ? tr("crm.preferences.greeting", { initial: state.firstNameInitial }) : tr("crm.preferences.greeting_anonymous")}</p>
        <p className="text-sm">{tr("crm.preferences.intro")}</p>
      </header>
      <div aria-live="polite" role="status">
        {doneMessage ? (
          <Alert>
            <AlertDescription>{doneMessage}</AlertDescription>
          </Alert>
        ) : null}
      </div>
      {confirmPurpose && !sp.done ? (
        <form action={confirmUnsubscribe} className="grid gap-3 rounded-md border border-border p-4">
          <input type="hidden" name="purpose" value={confirmPurpose} />
          <div>
            <Button type="submit">{tr("crm.preferences.confirm_unsubscribe", { purpose: purposeName(confirmPurpose) })}</Button>
          </div>
        </form>
      ) : null}
      {resubscribePurpose && !sp.done ? (
        <form action={confirmResubscribe} className="grid gap-3 rounded-md border border-border p-4">
          <input type="hidden" name="purpose" value={resubscribePurpose} />
          {wordings[resubscribePurpose] ? <p className="text-sm">{wordings[resubscribePurpose].text[locale]}</p> : null}
          <div>
            <Button type="submit">{tr("crm.email.confirm_resubscribe.cta")}</Button>
          </div>
        </form>
      ) : null}
      {!state.canEdit ? (
        <div className="grid gap-3">
          <p>{tr("crm.preferences.expired")}</p>
          {freshLinkForm(false)}
        </div>
      ) : null}
      <PreferenceSwitches
        mode={{ kind: "token", token }}
        items={MARKETING_PURPOSES.map((purpose) => ({ purpose, label: purposeName(purpose), wording: wordings[purpose]?.text[locale] ?? null }))}
        initial={state.purposes}
        suppressedAll={state.suppressedAll}
        canEdit={state.canEdit}
        languages={LOCALES.map((l) => ({ value: l, label: tr(`crm.enums.locale.${l.replace("-", "_")}`) }))}
        currentLocale={state.locale}
        labels={labels}
      />
      {!state.suppressedAll ? (
        <form action={confirmUnsubscribe}>
          <input type="hidden" name="purpose" value="all" />
          <noscript>
            <Button type="submit" variant="outline">
              {tr("crm.preferences.unsubscribe_all")}
            </Button>
          </noscript>
        </form>
      ) : null}
    </main>
  );
}
