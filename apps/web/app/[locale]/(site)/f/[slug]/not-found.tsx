/**
 * "This form is not available" (forms spec section 5 states, status 404): an unknown slug, a form
 * with no published version (for example `health-declaration` before the DPIA decision,
 * cross-module D39), or an unknown or revoked result token. Rendered in the URL's locale.
 */
import { requestLocale, translator } from "@/lib/i18n";
import { localeSegment } from "@/modules/forms/service/tokens";

export default async function FormNotFound() {
  const locale = await requestLocale();
  const tr = translator(locale);
  return (
    <div className="mx-auto max-w-xl space-y-4 px-4 py-16 text-center" data-status="404" data-form-state="not-available">
      <h1 className="text-3xl font-bold">{tr("forms.public.not_available_title")}</h1>
      <p className="text-muted-foreground">{tr("forms.public.not_available_body")}</p>
      <p>
        <a href={`/${localeSegment(locale)}`} className="font-medium underline">
          {tr("forms.public.home")}
        </a>
      </p>
    </div>
  );
}
