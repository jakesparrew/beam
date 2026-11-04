/**
 * JSON-LD for public pages (site spec section 5): `HealthAndBeautyBusiness` on home (with
 * `openingHoursSpecification` from `settings.business_hours` and
 * `specialOpeningHoursSpecification` for booking's exceptions, rule 58), `Event`, `BlogPosting`,
 * `FAQPage` for FAQ blocks and `BreadcrumbList` for nested paths. `serializeJsonLd` escapes `<`
 * so the script tag can never be closed by content.
 */
import type { AvailabilityBand } from "./types";

/** `settings.business_hours.week`: ISO weekday 1 (Monday) to 7, null = closed. */
export type WeeklyHours = { readonly [isoWeekday: string]: { opens_at: string; closes_at: string } | null | undefined };
export type SpecialHours = { onDate: string; opensAt: string | null; closesAt: string | null; name?: string | null };

export type BusinessFacts = {
  name: string;
  legalName?: string | null;
  vatId?: string | null;
  url: string;
  logo?: string | null;
  image?: string | null;
  telephone?: string | null;
  email?: string | null;
  address?: { street?: string | null; postal_code?: string | null; city?: string | null; country?: string | null } | null;
  sameAs?: string[];
  weeklyHours?: WeeklyHours | null;
  specialHours?: SpecialHours[];
};
export type EventFacts = {
  name: string;
  description?: string | null;
  url: string;
  startsAt: Date;
  endsAt: Date;
  status: "open" | "closed" | "cancelled";
  location?: string | null;
  image?: string | null;
  organizer: { name: string; url: string };
  offer?: { priceCents: number; band: AvailabilityBand } | null;
};
export type PostFacts = { headline: string; description?: string | null; url: string; datePublished: Date; dateModified?: Date | null; image?: string | null; publisher: { name: string; logo?: string | null } };
export type FaqFacts = { question: string; answer: string }[];
export type BreadcrumbFacts = { name: string; url: string }[];

export type JsonLdFacts = {
  locale: string;
  business?: BusinessFacts;
  event?: EventFacts;
  post?: PostFacts;
  faq?: FaqFacts;
  breadcrumbs?: BreadcrumbFacts;
};

const DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;
const compact = <T extends Record<string, unknown>>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== "")) as T;

export function openingHoursSpecification(hours: WeeklyHours | null | undefined): Record<string, unknown>[] {
  if (!hours) return [];
  const out: Record<string, unknown>[] = [];
  for (let d = 1; d <= 7; d++) {
    const h = hours[String(d)];
    if (!h) continue;
    out.push({ "@type": "OpeningHoursSpecification", dayOfWeek: `https://schema.org/${DAY_NAMES[d - 1]}`, opens: h.opens_at, closes: h.closes_at });
  }
  return out;
}

export function specialOpeningHoursSpecification(days: readonly SpecialHours[] | undefined): Record<string, unknown>[] {
  return (days ?? []).map((d) =>
    d.opensAt && d.closesAt
      ? { "@type": "OpeningHoursSpecification", validFrom: d.onDate, validThrough: d.onDate, opens: d.opensAt, closes: d.closesAt }
      : { "@type": "OpeningHoursSpecification", validFrom: d.onDate, validThrough: d.onDate, opens: "00:00", closes: "00:00" },
  );
}

function business(b: BusinessFacts): Record<string, unknown> {
  const a = b.address;
  return compact({
    "@context": "https://schema.org",
    "@type": "HealthAndBeautyBusiness",
    name: b.name,
    legalName: b.legalName,
    vatID: b.vatId,
    url: b.url,
    logo: b.logo,
    image: b.image ?? b.logo,
    telephone: b.telephone,
    email: b.email,
    address: a
      ? compact({ "@type": "PostalAddress", streetAddress: a.street, postalCode: a.postal_code, addressLocality: a.city, addressCountry: a.country ?? "BE" })
      : undefined,
    openingHoursSpecification: openingHoursSpecification(b.weeklyHours),
    specialOpeningHoursSpecification: specialOpeningHoursSpecification(b.specialHours),
    sameAs: b.sameAs?.length ? b.sameAs : undefined,
  });
}

const BAND_AVAILABILITY: Record<AvailabilityBand, string> = {
  available: "https://schema.org/InStock",
  few: "https://schema.org/LimitedAvailability",
  full: "https://schema.org/SoldOut",
};

function event(e: EventFacts): Record<string, unknown> {
  return compact({
    "@context": "https://schema.org",
    "@type": "Event",
    name: e.name,
    description: e.description,
    url: e.url,
    startDate: e.startsAt.toISOString(),
    endDate: e.endsAt.toISOString(),
    eventStatus: e.status === "cancelled" ? "https://schema.org/EventCancelled" : "https://schema.org/EventScheduled",
    eventAttendanceMode: "https://schema.org/OfflineEventAttendanceMode",
    location: compact({ "@type": "Place", name: e.location ?? e.organizer.name }),
    image: e.image,
    organizer: { "@type": "Organization", name: e.organizer.name, url: e.organizer.url },
    offers: e.offer
      ? { "@type": "Offer", price: (e.offer.priceCents / 100).toFixed(2), priceCurrency: "EUR", availability: BAND_AVAILABILITY[e.offer.band], url: e.url }
      : undefined,
  });
}

function post(p: PostFacts, locale: string): Record<string, unknown> {
  return compact({
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    headline: p.headline,
    description: p.description,
    url: p.url,
    mainEntityOfPage: p.url,
    inLanguage: locale,
    datePublished: p.datePublished.toISOString(),
    dateModified: (p.dateModified ?? p.datePublished).toISOString(),
    image: p.image,
    publisher: compact({ "@type": "Organization", name: p.publisher.name, logo: p.publisher.logo ? { "@type": "ImageObject", url: p.publisher.logo } : undefined }),
  });
}

function faq(items: FaqFacts): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: items.map((i) => ({ "@type": "Question", name: i.question, acceptedAnswer: { "@type": "Answer", text: i.answer } })),
  };
}

function breadcrumbs(items: BreadcrumbFacts): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((i, n) => ({ "@type": "ListItem", position: n + 1, name: i.name, item: i.url })),
  };
}

/** The JSON-LD objects of a page of `kind`. */
export function buildJsonLd(kind: string, facts: JsonLdFacts): object[] {
  const out: object[] = [];
  if (kind === "home" && facts.business) out.push(business(facts.business));
  if (kind === "event" && facts.event) out.push(event(facts.event));
  if (kind === "post" && facts.post) out.push(post(facts.post, facts.locale));
  if (facts.faq?.length) out.push(faq(facts.faq));
  if (facts.breadcrumbs && facts.breadcrumbs.length > 1) out.push(breadcrumbs(facts.breadcrumbs));
  return out;
}

/** JSON for a `<script type="application/ld+json">`, with `<`, `>`, `&` and line separators escaped. */
export function serializeJsonLd(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}
