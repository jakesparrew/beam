import { describe, expect, it } from "vitest";
import { buildJsonLd, serializeJsonLd } from "./jsonld";

const organizer = { name: "BEAM Vitality Center", url: "https://www.beam.be/nl" };

describe("buildJsonLd", () => {
  it("home: HealthAndBeautyBusiness with opening hours and special hours", () => {
    const [biz] = buildJsonLd("home", {
      locale: "nl-BE",
      business: {
        name: "BEAM Vitality Center",
        legalName: "Vibrant Lifestyle Collective BV",
        vatId: "BE0123456789",
        url: "https://www.beam.be/nl",
        address: { street: "Voorbeeldstraat 1", postal_code: "9000", city: "Gent", country: "BE" },
        sameAs: ["https://www.instagram.com/beam"],
        weeklyHours: { "1": null, "2": { opens_at: "08:30", closes_at: "19:00" }, "7": { opens_at: "10:00", closes_at: "18:00" } },
        specialHours: [
          { onDate: "2026-12-25", opensAt: null, closesAt: null, name: "Kerstmis" },
          { onDate: "2026-12-31", opensAt: "10:00", closesAt: "16:00", name: "Oudejaar" },
        ],
      },
    }) as Record<string, unknown>[];
    expect(biz).toMatchObject({ "@type": "HealthAndBeautyBusiness", name: "BEAM Vitality Center", legalName: "Vibrant Lifestyle Collective BV", vatID: "BE0123456789" });
    expect(biz!.address).toMatchObject({ "@type": "PostalAddress", addressLocality: "Gent", addressCountry: "BE" });
    expect(biz!.openingHoursSpecification).toEqual([
      { "@type": "OpeningHoursSpecification", dayOfWeek: "https://schema.org/Tuesday", opens: "08:30", closes: "19:00" },
      { "@type": "OpeningHoursSpecification", dayOfWeek: "https://schema.org/Sunday", opens: "10:00", closes: "18:00" },
    ]);
    expect(biz!.specialOpeningHoursSpecification).toEqual([
      { "@type": "OpeningHoursSpecification", validFrom: "2026-12-25", validThrough: "2026-12-25", opens: "00:00", closes: "00:00" },
      { "@type": "OpeningHoursSpecification", validFrom: "2026-12-31", validThrough: "2026-12-31", opens: "10:00", closes: "16:00" },
    ]);
  });

  it("event: Event with offer and status", () => {
    const [ev] = buildJsonLd("event", {
      locale: "en",
      event: {
        name: "Full moon night",
        url: "https://www.beam.be/en/events/full-moon",
        startsAt: new Date("2026-12-01T19:00:00Z"),
        endsAt: new Date("2026-12-01T23:00:00Z"),
        status: "cancelled",
        organizer,
        offer: { priceCents: 3500, band: "few" },
      },
    }) as Record<string, unknown>[];
    expect(ev).toMatchObject({
      "@type": "Event",
      startDate: "2026-12-01T19:00:00.000Z",
      eventStatus: "https://schema.org/EventCancelled",
      offers: { price: "35.00", priceCurrency: "EUR", availability: "https://schema.org/LimitedAvailability" },
    });
  });

  it("post: BlogPosting; FAQ blocks add FAQPage; nested paths add BreadcrumbList", () => {
    const out = buildJsonLd("post", {
      locale: "fr-BE",
      post: { headline: "Sauna et sommeil", url: "https://www.beam.be/fr/blog/sauna", datePublished: new Date("2026-10-01T08:00:00Z"), publisher: { name: "BEAM" } },
      faq: [{ question: "Combien de temps ?", answer: "Une heure." }],
      breadcrumbs: [
        { name: "Accueil", url: "https://www.beam.be/fr" },
        { name: "Blog", url: "https://www.beam.be/fr/blog" },
      ],
    }) as Record<string, unknown>[];
    expect(out.map((o) => o["@type"])).toEqual(["BlogPosting", "FAQPage", "BreadcrumbList"]);
    expect(out[0]).toMatchObject({ inLanguage: "fr-BE", dateModified: "2026-10-01T08:00:00.000Z" });
    expect(out[1]).toMatchObject({ mainEntity: [{ "@type": "Question", name: "Combien de temps ?", acceptedAnswer: { "@type": "Answer", text: "Une heure." } }] });
  });

  it("home without business facts and a page of another kind give nothing", () => {
    expect(buildJsonLd("home", { locale: "nl-BE" })).toEqual([]);
    expect(buildJsonLd("standard", { locale: "nl-BE", breadcrumbs: [{ name: "Home", url: "https://x.example.com" }] })).toEqual([]);
  });
});

describe("serializeJsonLd", () => {
  it("escapes < so content cannot close the script tag", () => {
    const s = serializeJsonLd({ name: "</script><script>alert(1)</script>", amp: "a & b" });
    expect(s).not.toContain("<");
    expect(s).not.toContain(">");
    expect(s).toContain("\\u003c/script\\u003e");
    expect(JSON.parse(s)).toEqual({ name: "</script><script>alert(1)</script>", amp: "a & b" });
  });
});
