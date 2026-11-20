/**
 * The public footer (site spec section 5): a navy band with the BEAM tagline and the booking pill,
 * the `footer` and `legal` menus, the newsletter through forms' `FormEmbed` (form `newsletter`, on
 * a light card so the form keeps its own contrast), social links, the "Cookie settings" entry point
 * (site-P5's consent dialog listens for `[data-cookie-settings]`), the company identification of
 * rule 60 and a discreet back-office link for staff.
 */
import type { Locale } from "@beam/core/i18n";
import { localePath } from "@beam/core/site";
import type { CompanyFooterView, PublicNavItem } from "../../queries/public";
import { ArrowBadge, goldButtonClass, type Tr } from "./block-renderer";
import { formEmbedProps, SafeFormEmbed } from "./blocks/form-embed";
import { CompanyFooter } from "./company-footer";

export const NEWSLETTER_FORM_SLUG = "newsletter";

function LinkList({ items, label }: { items: PublicNavItem[]; label: string }) {
  if (!items.length) return null;
  return (
    <nav aria-label={label}>
      <ul className="space-y-2.5 text-sm">
        {items.map((item) => (
          <li key={item.id}>
            <a href={item.href} rel={item.external ? "noopener" : undefined} className="text-muted-foreground transition hover:text-[#ffd76a]">
              {item.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

const headingClass = "text-xs font-semibold tracking-[0.2em] text-[#ffd76a] uppercase";

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
    <footer className="site-on-dark mt-auto bg-[#212842]">
      <div className="mx-auto max-w-7xl px-4 sm:px-6">
        <div className="flex flex-col items-start justify-between gap-6 border-b border-border py-12 md:flex-row md:items-center">
          <p className="font-display text-3xl text-[#fffaef] sm:text-4xl">{tr("site.public.brand.tagline")}</p>
          <a href={localePath(locale, "book")} className={`${goldButtonClass} py-2 pr-2 pl-6 text-base`}>
            {tr("site.public.header.book")}
            <ArrowBadge dark />
          </a>
        </div>
        <div className="grid gap-10 py-12 md:grid-cols-12">
          <div className="space-y-4 md:col-span-3">
            {/* eslint-disable-next-line @next/next/no-img-element -- a static brand file */}
            <img src="/brand/beam-logo-footer.png" alt="BEAM Vitality Center" width={360} height={350} className="h-28 w-auto" />
            <p className="max-w-sm text-sm leading-relaxed text-muted-foreground">{tr("site.public.brand.blurb")}</p>
            {company?.social.length ? (
              <div className="space-y-2 pt-2">
                <h2 className={headingClass}>{tr("site.public.footer.social")}</h2>
                <ul className="flex flex-wrap gap-2 text-sm">
                  {company.social.map((s) => (
                    <li key={s.key}>
                      <a href={s.href} rel="noopener" className="inline-flex rounded-full border border-border px-3 py-1 capitalize transition hover:border-[#ffd76a] hover:text-[#ffd76a]">
                        {s.key}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
          <div className="space-y-4 md:col-span-2">
            <h2 className={headingClass}>{tr("site.public.brand.quickLinks")}</h2>
            <LinkList items={footer} label={tr("platform.shell.navigation")} />
          </div>
          <div className="space-y-4 md:col-span-3">
            <h2 className={headingClass}>{tr("site.public.footer.legal")}</h2>
            <LinkList items={legal} label={tr("site.public.footer.legal")} />
            <button type="button" data-cookie-settings className="text-sm text-muted-foreground underline underline-offset-2 hover:text-[#ffd76a]">
              {tr("site.public.footer.cookieSettings")}
            </button>
          </div>
          <div className="site-on-light site-newsletter space-y-2 rounded-[1.75rem] bg-[#fffaef] p-6 text-[#212842] shadow-[0_20px_50px_-30px_rgba(0,0,0,0.6)] md:col-span-4">
            <h2 className="font-display text-2xl">{tr("site.public.footer.newsletterHeading")}</h2>
            {SafeFormEmbed(formEmbedProps(NEWSLETTER_FORM_SLUG, locale, pagePath, {}))}
          </div>
        </div>
        <div className="flex flex-col gap-6 border-t border-border py-8 md:flex-row md:items-end md:justify-between">
          {company ? <CompanyFooter company={company} tr={tr} /> : <span />}
          <a href="/admin" className="text-xs text-muted-foreground underline-offset-2 hover:text-[#ffd76a] hover:underline">
            {tr("site.public.brand.backOffice")}
          </a>
        </div>
      </div>
    </footer>
  );
}
