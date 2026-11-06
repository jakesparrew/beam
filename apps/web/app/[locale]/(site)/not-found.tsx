import { localePath } from "@beam/core/site";
import { requestLocale, translator } from "@/lib/i18n";
import { getSingletonHref } from "@/modules/site/queries";
import { isMarkedGone } from "@/modules/site/server/resolve";

/**
 * 404 and 410 pages of the public site, in the URL's locale, with navigation back to home and to
 * the events index (site spec section 5). A gone path renders the "no longer available" text.
 */
export default async function SiteNotFound() {
  const locale = await requestLocale();
  const tr = translator(locale);
  const gone = isMarkedGone();
  const events = await getSingletonHref("events_index", locale).catch(() => null);
  return (
    <div className="mx-auto max-w-xl space-y-4 px-4 py-16 text-center" data-status={gone ? "410" : "404"} data-not-found="">
      <h1 className="text-3xl font-bold">{gone ? tr("site.public.gone.title") : tr("site.public.notFound.title")}</h1>
      <p className="text-muted-foreground">{gone ? tr("site.public.gone.body") : tr("site.public.notFound.body")}</p>
      <ul className="flex justify-center gap-6">
        <li>
          <a href={localePath(locale, "")} className="font-medium underline">
            {tr("site.public.notFound.home")}
          </a>
        </li>
        {events ? (
          <li>
            <a href={events} className="font-medium underline">
              {tr("site.blocks.events.more")}
            </a>
          </li>
        ) : null}
      </ul>
    </div>
  );
}
