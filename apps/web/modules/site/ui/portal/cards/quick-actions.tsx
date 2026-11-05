/**
 * Account home "Quick actions" (site rule 47, section 5; site-P6): links into the pages of
 * booking, commerce, finance, email and crm. The home only links; it owns none of them (rule 49).
 * R2 (site-P8): "Shared with me" links to the shared packages on credits' packages page while at
 * least one package is shared with the person.
 */
import Link from "next/link";
import type { Route } from "next";
import type { Locale } from "@beam/core/i18n";
import { portalPath, type PortalRoute } from "@beam/core/site";
import { Badge, buttonVariants } from "@beam/ui";
import type { Result } from "../../../queries/portal";
import type { Tr } from "./bookings-card";

export const QUICK_ACTIONS: readonly { key: string; route: PortalRoute }[] = [
  { key: "bookDay", route: "book_day" },
  { key: "bookNight", route: "book_night" },
  { key: "buyPackage", route: "shop" },
  { key: "inviteGuest", route: "bookings" },
  { key: "invoices", route: "invoices" },
  { key: "preferences", route: "preferences" },
  { key: "profile", route: "profile" },
];

/** The "Shared with me" section of credits' packages page (`/[locale]/account/packages`). */
export function sharedWithMePath(locale: Locale): string {
  return `${portalPath(locale, "packages")}#packages-shared`;
}

export function QuickActions({ locale, tr, sharedWithMe }: { locale: Locale; tr: Tr; sharedWithMe?: Result<number> }) {
  const shared = sharedWithMe?.ok ? sharedWithMe.data : 0;
  return (
    <section aria-labelledby="home-quick-title" data-home-card="quick-actions">
      <h2 id="home-quick-title" className="mb-3 text-lg font-semibold">
        {tr("site.portal.home.quickTitle")}
      </h2>
      <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {QUICK_ACTIONS.map((a) => (
          <li key={a.key}>
            <Link
              href={portalPath(locale, a.route) as Route}
              data-quick-action={a.key}
              className={buttonVariants({ variant: "outline", className: "w-full justify-start" })}
            >
              {tr(`site.portal.home.quick.${a.key}`)}
            </Link>
          </li>
        ))}
        {shared > 0 ? (
          <li>
            <Link
              href={sharedWithMePath(locale) as Route}
              data-quick-action="sharedWithMe"
              className={buttonVariants({ variant: "outline", className: "w-full justify-start gap-2" })}
            >
              <span>{tr("site.portal.home.sharedWithMe")}</span>
              <Badge variant="secondary" aria-hidden="true">
                {shared}
              </Badge>
              <span className="sr-only">{tr("site.portal.home.sharedWithMeBody", { count: shared })}</span>
            </Link>
          </li>
        ) : null}
      </ul>
    </section>
  );
}
