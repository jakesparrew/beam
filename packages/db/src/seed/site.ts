/**
 * site seeds (site-P7, site spec section 8 "Content seeded"; runbook 3.4 BS-11).
 *
 * - `seed` (the `defaults` profile): in development, previews, tests and demos it creates the
 *   placeholder pages `home`, `about`, `day-sessions`, `nights`, `memberships`, `pricing`,
 *   `events`, `blog`, `contact` and the legal pages `privacy`, `terms` (the chapters of rule 62),
 *   `cookies`, `accessibility` and `guardian-consent` in nl-BE, fr-BE and en, each with a published
 *   version 1 and live routes (so `getCurrentLegalVersion(db, 'terms')` and `'guardian_consent'`
 *   are non-null), the three menus and the `site` settings row. In production and staging
 *   (`APP_ENV`) it creates nothing: content comes from the WordPress import and staff.
 * - Idempotent: pages `on conflict do nothing` (slug, and the singleton and legal-key indexes), a
 *   version only for a page this run created, routes and menus `on conflict do nothing`.
 * BEAM writes the real texts (proposal section 2); these are placeholders.
 */
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { DEFAULT_SITE_SETTINGS, type Block, type NavItem, type PageKind, type PageSeo, type RichBlockNode } from "@beam/core/site";
import type { DbOrTx } from "../client";
import { settings } from "../schema/platform";
import { navMenus, pageRoutes, pages, pageVersions } from "../schema/site";
import type { Locale, LocalizedText } from "../schema/_shared";
import type { DefaultSeed } from "./run";

type L3 = [nl: string, fr: string, en: string];
const LOCALES: readonly Locale[] = ["nl-BE", "fr-BE", "en"];
const per = <T>(f: (i: number, l: Locale) => T): Record<Locale, T> => ({ "nl-BE": f(0, "nl-BE"), "fr-BE": f(1, "fr-BE"), en: f(2, "en") });
const txt = (v: L3): LocalizedText => per((i) => v[i]!);

/** A stable uuid (v4 layout) from a name, so seeded block and menu ids never change. */
export function seedUuid(name: string): string {
  const h = createHash("sha1").update(`beam-site-seed:${name}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${((parseInt(h.slice(16, 17), 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** A section: an `h2` heading and its paragraphs. */
type Section = { h: L3; p: L3[] };

type SeedPage = {
  slug: string;
  kind: PageKind;
  legalKey?: "privacy_notice" | "terms" | "cookie_notice" | "accessibility_statement" | "guardian_consent";
  title: L3;
  path: L3;
  description: L3;
  sections: Section[];
  extra?: "hero" | "events" | "posts" | "contact" | "legal" | "booking";
  noindex?: boolean;
};

const PLACEHOLDER: L3 = [
  "Deze tekst is een voorbeeld. BEAM schrijft de definitieve inhoud voor de lancering.",
  "Ce texte est un exemple. BEAM rédige le contenu définitif avant le lancement.",
  "This text is a placeholder. BEAM writes the final content before launch.",
];

const desc = (subject: L3): L3 => [
  `${subject[0]} bij BEAM Vitality Center: rust, warmte en water in het hart van de stad.`,
  `${subject[1]} au BEAM Vitality Center : repos, chaleur et eau au cœur de la ville.`,
  `${subject[2]} at BEAM Vitality Center: rest, warmth and water in the heart of the city.`,
];

/** Rule 62: the chapters of the terms, as `h2` sections. */
const TERMS_CHAPTERS: Section[] = [
  { h: ["Algemene voorwaarden", "Conditions générales", "General conditions"], p: [PLACEHOLDER] },
  { h: ["Huisregels", "Règlement intérieur", "House rules"], p: [PLACEHOLDER] },
  {
    h: ["Gezondheidsverklaring", "Déclaration de santé", "Health self-declaration"],
    p: [[
      "Ik heb geen medische reden om de sauna en de faciliteiten niet te gebruiken, of ik heb het aan mijn arts gevraagd.",
      "Je n'ai aucune raison médicale de ne pas utiliser le sauna et les installations, ou j'ai consulté mon médecin.",
      "I have no medical reason not to use the sauna and the facilities, or I asked my doctor.",
    ]],
  },
  { h: ["Annuleringsbeleid", "Politique d'annulation", "Cancellation policy"], p: [PLACEHOLDER] },
  {
    h: ["Geen herroepingsrecht voor boekingen op een datum", "Pas de droit de rétractation pour les réservations datées", "No right of withdrawal for date-specific bookings"],
    p: [[
      "Voor vrijetijdsdiensten op een vaste datum geldt geen herroepingsrecht (Wetboek van economisch recht, art. VI.53, 12°). Voor aankopen zonder datum geldt een herroepingstermijn van 14 dagen.",
      "Les services de loisirs à une date déterminée ne bénéficient pas du droit de rétractation (Code de droit économique, art. VI.53, 12°). Les achats sans date bénéficient d'un délai de rétractation de 14 jours.",
      "Leisure services on a fixed date have no right of withdrawal (Belgian Code of Economic Law, art. VI.53, 12°). Purchases without a date have a 14-day withdrawal period.",
    ]],
  },
  { h: ["Voorwaarden lidmaatschap", "Conditions d'abonnement", "Membership conditions"], p: [PLACEHOLDER] },
];

export const SITE_SEED_PAGES: readonly SeedPage[] = [
  { slug: "home", kind: "home", title: ["Welkom bij BEAM", "Bienvenue chez BEAM", "Welcome to BEAM"], path: ["", "", ""], description: desc(["Dagsessies en nachten", "Journées et nuits", "Day sessions and nights"]), sections: [{ h: ["Rust in de stad", "Le calme en ville", "Calm in the city"], p: [PLACEHOLDER] }], extra: "hero" },
  { slug: "about", kind: "standard", title: ["Over ons", "À propos", "About us"], path: ["over-ons", "a-propos", "about"], description: desc(["Ons verhaal", "Notre histoire", "Our story"]), sections: [{ h: ["Ons verhaal", "Notre histoire", "Our story"], p: [PLACEHOLDER] }] },
  { slug: "day-sessions", kind: "offer", title: ["Dagsessies", "Sessions de jour", "Day sessions"], path: ["dagsessies", "sessions-de-jour", "day-sessions"], description: desc(["Een dag rust", "Une journée de repos", "A day of rest"]), sections: [{ h: ["Een dag bij BEAM", "Une journée chez BEAM", "A day at BEAM"], p: [PLACEHOLDER] }], extra: "booking" },
  { slug: "nights", kind: "offer", title: ["Nachten", "Nuits", "Nights"], path: ["nachten", "nuits", "nights"], description: desc(["Avonden en nachten", "Soirées et nuits", "Evenings and nights"]), sections: [{ h: ["De nacht", "La nuit", "The night"], p: [PLACEHOLDER] }] },
  { slug: "memberships", kind: "offer", title: ["Lidmaatschappen", "Abonnements", "Memberships"], path: ["lidmaatschappen", "abonnements", "memberships"], description: desc(["Lid worden", "Devenir membre", "Becoming a member"]), sections: [{ h: ["Lid worden", "Devenir membre", "Become a member"], p: [PLACEHOLDER] }] },
  { slug: "pricing", kind: "pricing", title: ["Prijzen", "Tarifs", "Pricing"], path: ["prijzen", "tarifs", "pricing"], description: desc(["Onze prijzen", "Nos tarifs", "Our prices"]), sections: [{ h: ["Onze prijzen", "Nos tarifs", "Our prices"], p: [PLACEHOLDER] }] },
  { slug: "events", kind: "events_index", title: ["Evenementen", "Événements", "Events"], path: ["evenementen", "evenements", "events"], description: desc(["Evenementen", "Les événements", "Events"]), sections: [], extra: "events" },
  { slug: "blog", kind: "blog_index", title: ["Nieuws", "Actualités", "News"], path: ["blog", "blog", "blog"], description: desc(["Nieuws", "Les actualités", "News"]), sections: [], extra: "posts" },
  { slug: "contact", kind: "contact", title: ["Contact", "Contact", "Contact"], path: ["contact", "contact", "contact"], description: desc(["Contact en openingsuren", "Contact et horaires", "Contact and opening hours"]), sections: [], extra: "contact" },
  {
    slug: "privacy",
    kind: "legal",
    legalKey: "privacy_notice",
    title: ["Privacyverklaring", "Déclaration de confidentialité", "Privacy notice"],
    path: ["privacy", "confidentialite", "privacy"],
    description: desc(["Hoe we met uw gegevens omgaan", "Comment nous traitons vos données", "How we handle your data"]),
    sections: [{
      h: ["Verwerkingsverantwoordelijke", "Responsable du traitement", "Controller"],
      p: [["De verwerkingsverantwoordelijke is Vibrant Lifestyle Collective BV.", "Le responsable du traitement est Vibrant Lifestyle Collective BV.", "The controller is Vibrant Lifestyle Collective BV."], PLACEHOLDER],
    }],
    extra: "legal",
  },
  { slug: "terms", kind: "legal", legalKey: "terms", title: ["Algemene voorwaarden", "Conditions générales", "Terms and conditions"], path: ["voorwaarden", "conditions", "terms"], description: desc(["De voorwaarden", "Les conditions", "The terms"]), sections: TERMS_CHAPTERS, extra: "legal" },
  { slug: "cookies", kind: "legal", legalKey: "cookie_notice", title: ["Cookieverklaring", "Politique en matière de cookies", "Cookie notice"], path: ["cookies", "cookies", "cookies"], description: desc(["Cookies", "Les cookies", "Cookies"]), sections: [{ h: ["Welke cookies we gebruiken", "Les cookies que nous utilisons", "Which cookies we use"], p: [PLACEHOLDER] }], extra: "legal" },
  {
    slug: "accessibility",
    kind: "legal",
    legalKey: "accessibility_statement",
    title: ["Toegankelijkheidsverklaring", "Déclaration d'accessibilité", "Accessibility statement"],
    path: ["toegankelijkheid", "accessibilite", "accessibility"],
    description: desc(["Toegankelijkheid", "L'accessibilité", "Accessibility"]),
    sections: [{ h: ["WCAG 2.1 AA", "WCAG 2.1 AA", "WCAG 2.1 AA"], p: [["Deze website streeft naar conformiteit met WCAG 2.1 niveau AA.", "Ce site vise la conformité aux WCAG 2.1 niveau AA.", "This website aims to conform to WCAG 2.1 level AA."], PLACEHOLDER] }],
    extra: "legal",
  },
  { slug: "guardian-consent", kind: "legal", legalKey: "guardian_consent", title: ["Toestemming ouder of voogd", "Consentement parental", "Guardian consent"], path: ["toestemming-ouders", "consentement-parental", "guardian-consent"], description: desc(["Toestemming voor minderjarigen", "Le consentement pour les mineurs", "Consent for minors"]), sections: [{ h: ["Toestemming", "Consentement", "Consent"], p: [PLACEHOLDER] }], extra: "legal", noindex: true },
];

const text = (t: string) => [{ type: "text" as const, text: t }];

/** The blocks of a seeded page in one locale. */
function blocksOf(page: SeedPage, i: number): Block[] {
  const id = (part: string) => seedUuid(`${page.slug}:${i}:${part}`);
  const out: Block[] = [];
  if (page.extra === "hero") out.push({ id: id("hero"), type: "hero", heading: page.title[i]!, subheading: page.description[i]! });
  const doc: RichBlockNode[] = [];
  for (const s of page.sections) {
    doc.push({ type: "heading", attrs: { level: 2 }, content: text(s.h[i]!) });
    for (const p of s.p) doc.push({ type: "paragraph", content: text(p[i]!) });
  }
  if (doc.length) out.push({ id: id("text"), type: "rich_text", doc: { type: "doc", content: doc } });
  if (page.extra === "booking") out.push({ id: id("cta"), type: "booking_cta", label: ["Boek een dag", "Réserver une journée", "Book a day"][i]!, target: { kind: "book_day" } });
  if (page.extra === "events") out.push({ id: id("events"), type: "events_list", limit: 12, showFull: true });
  if (page.extra === "posts") out.push({ id: id("posts"), type: "posts_list", limit: 12, paginate: true });
  if (page.extra === "contact") out.push({ id: id("contact"), type: "contact_details", showAddress: true, showPhone: true, showEmail: true, showOpeningHours: true });
  if (page.extra === "legal") out.push({ id: id("legal"), type: "legal_meta" });
  return out;
}

const MENUS: { key: "header" | "footer" | "legal"; slugs: string[] }[] = [
  { key: "header", slugs: ["day-sessions", "nights", "memberships", "pricing", "events", "blog", "about", "contact"] },
  { key: "footer", slugs: ["about", "events", "blog", "contact"] },
  { key: "legal", slugs: ["privacy", "terms", "cookies", "accessibility", "guardian-consent"] },
];

/** True where placeholder content may be seeded: not in production or staging (`APP_ENV`). */
export function siteContentSeedAllowed(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return env.APP_ENV !== "production" && env.APP_ENV !== "staging";
}

/**
 * Seeds the placeholder pages (published v1 and live routes), the menus and the `site` settings
 * row. Returns the slugs of the pages this run created.
 */
export async function seedSiteContent(db: DbOrTx, opts: { now?: Date } = {}): Promise<string[]> {
  const now = opts.now ?? new Date();
  await db.insert(settings).values({ key: "site", value: DEFAULT_SITE_SETTINGS }).onConflictDoNothing({ target: settings.key });

  const created: string[] = [];
  for (const page of SITE_SEED_PAGES) {
    const [row] = await db
      .insert(pages)
      .values({ kind: page.kind, slug: page.slug, legalKey: page.legalKey ?? null, status: "draft" })
      .onConflictDoNothing()
      .returning({ id: pages.id });
    if (!row) continue;
    const seo = per<PageSeo>((i) => ({ title: page.title[i]!.slice(0, 70), description: page.description[i]!, ...(page.noindex ? { noindex: true } : {}) }));
    const [version] = await db
      .insert(pageVersions)
      .values({
        pageId: row.id,
        version: 1,
        state: "published",
        title: txt(page.title),
        paths: txt(page.path),
        blocks: per((i) => blocksOf(page, i)),
        seo,
        locales: [...LOCALES],
        createdBy: "user",
        changeSummary: "Seed placeholder content",
        publishedAt: now,
      })
      .returning({ id: pageVersions.id });
    await db.update(pages).set({ status: "published", currentVersionId: version!.id, firstPublishedAt: now, updatedAt: now }).where(eq(pages.id, row.id));
    await db
      .insert(pageRoutes)
      .values(LOCALES.map((locale, i) => ({ pageId: row.id, locale, path: page.path[i]!, versionId: version!.id })))
      .onConflictDoNothing();
    created.push(page.slug);
  }

  const ids = new Map((await db.select({ id: pages.id, slug: pages.slug }).from(pages)).map((p) => [p.slug, p.id]));
  for (const menu of MENUS) {
    const items: NavItem[] = menu.slugs
      .filter((s) => ids.has(s))
      .map((s) => {
        const p = SITE_SEED_PAGES.find((x) => x.slug === s)!;
        return { id: seedUuid(`menu:${menu.key}:${s}`), label: txt(p.title), target: { kind: "page", pageId: ids.get(s)! } };
      });
    await db.insert(navMenus).values({ key: menu.key, items }).onConflictDoNothing({ target: navMenus.key });
  }
  return created;
}

export const seed: DefaultSeed = {
  after: ["platform"],
  run: async (db) => {
    if (!siteContentSeedAllowed()) return;
    await seedSiteContent(db);
  },
};

/** The demo blog post (`demo` profile helper, called by `apps/web/modules/site/seed.ts`). */
export const DEMO_POST_SLUG = "welcome-to-beam";

/**
 * The `demo` profile: the placeholder content (if the defaults did not run) plus one published
 * blog post, so the blog index, RSS feed and posts list show something. Idempotent on the slug.
 */
export async function seedSiteDemo(db: DbOrTx, opts: { now?: Date } = {}): Promise<{ postCreated: boolean }> {
  const now = opts.now ?? new Date();
  await seedSiteContent(db, { now });
  const [row] = await db.insert(pages).values({ kind: "post", slug: DEMO_POST_SLUG, status: "draft" }).onConflictDoNothing().returning({ id: pages.id });
  if (!row) return { postCreated: false };
  const title: L3 = ["BEAM opent de deuren", "BEAM ouvre ses portes", "BEAM opens its doors"];
  const path: L3 = ["blog/beam-opent-de-deuren", "blog/beam-ouvre-ses-portes", "blog/beam-opens-its-doors"];
  const excerpt: L3 = [
    "Een nieuw adres voor rust, warmte en water in de stad. Ontdek de dagsessies en de nachten.",
    "Une nouvelle adresse pour le repos, la chaleur et l'eau en ville. Découvrez les journées et les nuits.",
    "A new address for rest, warmth and water in the city. Discover the day sessions and the nights.",
  ];
  const [version] = await db
    .insert(pageVersions)
    .values({
      pageId: row.id,
      version: 1,
      state: "published",
      title: txt(title),
      paths: txt(path),
      excerpt: txt(excerpt),
      blocks: per((i) => [{ id: seedUuid(`demo-post:${i}`), type: "rich_text", doc: { type: "doc", content: [{ type: "paragraph", content: text(excerpt[i]!) }, { type: "paragraph", content: text(PLACEHOLDER[i]!) }] } }] as Block[]),
      seo: per<PageSeo>((i) => ({ title: title[i]!, description: excerpt[i]! })),
      locales: [...LOCALES],
      createdBy: "user",
      changeSummary: "Demo post",
      publishedAt: now,
    })
    .returning({ id: pageVersions.id });
  await db.update(pages).set({ status: "published", currentVersionId: version!.id, firstPublishedAt: now, updatedAt: now }).where(eq(pages.id, row.id));
  await db
    .insert(pageRoutes)
    .values(LOCALES.map((locale, i) => ({ pageId: row.id, locale, path: path[i]!, versionId: version!.id })))
    .onConflictDoNothing();
  return { postCreated: true };
}
