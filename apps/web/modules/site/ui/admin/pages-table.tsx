/**
 * The section tabs of the "Website" area (site spec section 5), drawn like the back-office kit's
 * segmented control (owner review, November 2026; the kit itself is platform's and may not be
 * imported here, PL-82). The pages table renders in `/admin/site` with the kit.
 */
import NextLink from "next/link";
import type { SiteAdminLabels } from "../../queries/admin";

const SECTIONS = [
  ["/admin/site", "nav.pages"],
  ["/admin/site/navigation", "nav.navigation"],
  ["/admin/site/media", "nav.media"],
  ["/admin/site/redirects", "nav.redirects"],
  ["/admin/site/imports", "nav.imports"],
  ["/admin/site/insights", "nav.insights"],
  ["/admin/site/settings", "nav.settings"],
] as const;

/** The section links of the "Website" area. */
export function SiteSectionNav({ L, current }: { L: SiteAdminLabels; current: (typeof SECTIONS)[number][0] }) {
  return (
    <nav aria-label={L["nav.website"]} className="flex w-fit max-w-full flex-wrap rounded-lg bg-muted p-0.5 text-[0.8125rem] font-medium">
      {SECTIONS.map(([href, key]) => (
        <NextLink
          key={href}
          href={href}
          aria-current={href === current ? "page" : undefined}
          className={`rounded-md px-3 py-1 whitespace-nowrap ${href === current ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
        >
          {L[key]}
        </NextLink>
      ))}
    </nav>
  );
}
