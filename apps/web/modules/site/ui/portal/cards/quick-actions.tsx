/**
 * Account home "Quick actions" (site rule 47, section 5; site-P6): links into the pages of
 * booking, commerce, finance, email and crm. The home only links; it owns none of them (rule 49).
 * R2 (site-P8): "Shared with me" links to the shared packages on credits' packages page while at
 * least one package is shared with the person. Rendered as icon tiles.
 */
import Link from "next/link";
import type { Route } from "next";
import type { Locale } from "@beam/core/i18n";
import { portalPath, type PortalRoute } from "@beam/core/site";
import { NavIcon } from "@beam/ui";
import type { Result } from "../../../queries/portal";
import type { Tr } from "./bookings-card";

export const QUICK_ACTIONS: readonly { key: string; route: PortalRoute; icon: string }[] = [
  { key: "bookDay", route: "book_day", icon: "calendar" },
  { key: "bookNight", route: "book_night", icon: "clock" },
  { key: "buyPackage", route: "shop", icon: "package" },
  { key: "inviteGuest", route: "bookings", icon: "users" },
  { key: "invoices", route: "invoices", icon: "receipt" },
  { key: "preferences", route: "preferences", icon: "mail" },
  { key: "profile", route: "profile", icon: "user" },
];

/** The "Shared with me" section of credits' packages page (`/[locale]/account/packages`). */
export function sharedWithMePath(locale: Locale): string {
  return `${portalPath(locale, "packages")}#packages-shared`;
}

const TILE =
  "group flex h-full items-center gap-3 rounded-2xl bg-card p-4 shadow-[0_1px_2px_rgb(33_40_66/0.04),0_10px_28px_-18px_rgb(33_40_66/0.25)] transition hover:-translate-y-0.5 hover:shadow-[0_1px_2px_rgb(33_40_66/0.04),0_16px_32px_-16px_rgb(33_40_66/0.3)]";

function Tile({ href, icon, label, quick, extra }: { href: string; icon: string; label: string; quick: string; extra?: React.ReactNode }) {
  return (
    <Link href={href as Route} data-quick-action={quick} className={TILE}>
      <span className="grid size-10 shrink-0 place-items-center rounded-full bg-[#f4ead3] text-[#a0621e]">
        <NavIcon icon={icon} className="size-[18px]" />
      </span>
      <span className="flex-1 text-sm font-medium">{label}</span>
      {extra}
      <span aria-hidden="true" className="text-muted-foreground transition group-hover:translate-x-0.5">
        →
      </span>
    </Link>
  );
}

export function QuickActions({ locale, tr, sharedWithMe }: { locale: Locale; tr: Tr; sharedWithMe?: Result<number> }) {
  const shared = sharedWithMe?.ok ? sharedWithMe.data : 0;
  return (
    <section aria-labelledby="home-quick-title" data-home-card="quick-actions">
      <h2 id="home-quick-title" className="font-display mb-4 text-2xl">
        {tr("site.portal.home.quickTitle")}
      </h2>
      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {QUICK_ACTIONS.map((a) => (
          <li key={a.key}>
            <Tile href={portalPath(locale, a.route)} icon={a.icon} label={tr(`site.portal.home.quick.${a.key}`)} quick={a.key} />
          </li>
        ))}
        {shared > 0 ? (
          <li>
            <Tile
              href={sharedWithMePath(locale)}
              icon="gift"
              label={tr("site.portal.home.sharedWithMe")}
              quick="sharedWithMe"
              extra={
                <>
                  <span aria-hidden="true" className="rounded-full bg-[#212842] px-2 py-0.5 text-xs text-[#fffaef]">
                    {shared}
                  </span>
                  <span className="sr-only">{tr("site.portal.home.sharedWithMeBody", { count: shared })}</span>
                </>
              }
            />
          </li>
        ) : null}
      </ul>
    </section>
  );
}
