/**
 * Account home "Quick actions" (site rule 47, section 5; site-P6): links into the pages of
 * booking, commerce, finance, email and crm. The home only links; it owns none of them (rule 49).
 */
import Link from "next/link";
import type { Route } from "next";
import type { Locale } from "@beam/core/i18n";
import { portalPath, type PortalRoute } from "@beam/core/site";
import { buttonVariants } from "@beam/ui";
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

export function QuickActions({ locale, tr }: { locale: Locale; tr: Tr }) {
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
      </ul>
    </section>
  );
}
