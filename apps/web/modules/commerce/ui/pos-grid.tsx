/**
 * The POS product grid (commerce spec 5.1, rule 56): kind tabs (Sessions today, Packages,
 * Memberships, Tickets, Vouchers, Items) over the `is_pos_visible` products, and today's
 * sessions with free seats. Every tile is a link that adds the product to the basket kept in the
 * URL, so the grid works without JavaScript and by keyboard; tiles are at least 44 px high.
 * A server component: it receives its texts already translated.
 */
import Link from "next/link";
import { formatDateTime, formatMoney, type Locale } from "@beam/core/i18n";

export const POS_TABS = ["sessions", "package", "membership", "ticket", "voucher", "item"] as const;
export type PosTab = (typeof POS_TABS)[number];

export type PosGridProduct = { id: string; name: string; sku: string; priceCents: number | null; href: string };
export type PosGridSession = { sessionId: string; title: string; startsAt: Date; free: number; priceCents: number | null; href: string | null };

export function PosGrid(props: {
  locale: Locale;
  active: PosTab;
  tabHref: (tab: PosTab) => string;
  products: PosGridProduct[];
  sessions: PosGridSession[];
  text: {
    tabsLabel: string;
    tab: (tab: PosTab) => string;
    add: (name: string) => string;
    seatsFree: (count: number) => string;
    noSessions: string;
    noProducts: string;
    noPrice: string;
  };
}) {
  const { locale, active, text } = props;
  const money = (c: number | null) => (c === null ? text.noPrice : formatMoney(c, locale));
  const tile = "flex min-h-11 flex-col justify-between gap-1 rounded-md border p-3 text-left text-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
  return (
    <section aria-labelledby="pos-grid-title" className="grid gap-3">
      <h2 id="pos-grid-title" className="sr-only">
        {text.tabsLabel}
      </h2>
      <nav aria-label={text.tabsLabel} className="flex flex-wrap gap-2">
        {POS_TABS.map((tab) => (
          <Link
            key={tab}
            href={props.tabHref(tab) as never}
            aria-current={tab === active ? "page" : undefined}
            className={`inline-flex min-h-11 items-center rounded-md border px-3 text-sm ${tab === active ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`}
          >
            {text.tab(tab)}
          </Link>
        ))}
      </nav>
      {active === "sessions" ? (
        props.sessions.length ? (
          <ul className="grid grid-cols-2 gap-2 lg:grid-cols-3">
            {props.sessions.map((s) => (
              <li key={s.sessionId}>
                {s.href ? (
                  <Link href={s.href as never} className={tile} aria-label={text.add(`${s.title} ${formatDateTime(s.startsAt, locale, "short")}`)}>
                    <span className="font-medium">{s.title}</span>
                    <span>{formatDateTime(s.startsAt, locale, "short")}</span>
                    <span className="flex justify-between gap-2 text-muted-foreground">
                      <span>{text.seatsFree(s.free)}</span>
                      <span className="tabular-nums">{money(s.priceCents)}</span>
                    </span>
                  </Link>
                ) : (
                  <div className={`${tile} opacity-70`}>
                    <span className="font-medium">{s.title}</span>
                    <span>{formatDateTime(s.startsAt, locale, "short")}</span>
                    <span className="text-muted-foreground">{text.noPrice}</span>
                  </div>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">{text.noSessions}</p>
        )
      ) : props.products.length ? (
        <ul className="grid grid-cols-2 gap-2 lg:grid-cols-3">
          {props.products.map((p) => (
            <li key={p.id}>
              <Link href={p.href as never} className={tile} aria-label={text.add(p.name)}>
                <span className="font-medium">{p.name}</span>
                <span className="flex justify-between gap-2 text-muted-foreground">
                  <span>{p.sku}</span>
                  <span className="tabular-nums">{money(p.priceCents)}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">{text.noProducts}</p>
      )}
    </section>
  );
}
