/**
 * The public footer (site spec section 5): the `footer` and `legal` menus, the newsletter
 * through forms' `FormEmbed` (form `newsletter`), social links, the "Cookie settings" entry
 * point (site-P5's consent dialog listens for `[data-cookie-settings]`) and the company
 * identification of rule 60.
 */
import type { Locale } from "@beam/core/i18n";
import type { CompanyFooterView, PublicNavItem } from "../../queries/public";
import type { Tr } from "./block-renderer";
import { formEmbedProps, SafeFormEmbed } from "./blocks/form-embed";
import { CompanyFooter } from "./company-footer";

export const NEWSLETTER_FORM_SLUG = "newsletter";

function LinkList({ items, label }: { items: PublicNavItem[]; label: string }) {
  if (!items.length) return null;
  return (
    <nav aria-label={label}>
      <ul className="space-y-2 text-sm">
        {items.map((item) => (
          <li key={item.id}>
            <a href={item.href} rel={item.external ? "noopener" : undefined} className="hover:underline">
              {item.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export function SiteFooter({
  locale,
  footer,
  legal,
  company,
  tr,
  pagePath,
}: {
  locale: Locale;
  footer: PublicNavItem[];
  legal: PublicNavItem[];
  company: CompanyFooterView | null;
  tr: Tr;
  pagePath: string;
}) {
  return (
    <footer className="mt-auto border-t border-border bg-muted/40">
      <div className="mx-auto grid max-w-6xl gap-10 px-4 py-12 sm:px-6 md:grid-cols-3">
        <div className="space-y-4">
          <LinkList items={footer} label={tr("platform.shell.navigation")} />
          {company?.social.length ? (
            <div className="space-y-2">
              <h2 className="text-sm font-semibold">{tr("site.public.footer.social")}</h2>
              <ul className="flex gap-4 text-sm">
                {company.social.map((s) => (
                  <li key={s.key}>
                    <a href={s.href} rel="noopener" className="capitalize hover:underline">
                      {s.key}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
        <div className="space-y-3">
          <h2 className="text-sm font-semibold">{tr("site.public.footer.newsletterHeading")}</h2>
          {SafeFormEmbed(formEmbedProps(NEWSLETTER_FORM_SLUG, locale, pagePath, {}))}
        </div>
        <div className="space-y-4">
          <div className="space-y-2">
            <h2 className="text-sm font-semibold">{tr("site.public.footer.legal")}</h2>
            <LinkList items={legal} label={tr("site.public.footer.legal")} />
            <button type="button" data-cookie-settings className="text-sm underline hover:no-underline">
              {tr("site.public.footer.cookieSettings")}
            </button>
          </div>
          {company ? <CompanyFooter company={company} tr={tr} /> : null}
        </div>
      </div>
    </footer>
  );
}
