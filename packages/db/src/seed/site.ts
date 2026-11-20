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
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { DEFAULT_SITE_SETTINGS, imageSize, type Block, type Link, type NavItem, type PageKind, type PageSeo, type RichBlockNode, type RichDoc, type RichTextNode } from "@beam/core/site";
import type { DbOrTx } from "../client";
import { files, settings } from "../schema/platform";
import { mediaAssets, navMenus, pageRoutes, pages, pageVersions } from "../schema/site";
import type { Locale, LocalizedText } from "../schema/_shared";
import type { DefaultSeed } from "./run";
import { BEAM_SKUS } from "./commerce";
import { products } from "../schema/commerce";

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
  /** Full block list per locale; when set, `sections` and `extra` are not used. */
  build?: Builder;
};

const PLACEHOLDER: L3 = [
  "Deze tekst is een voorbeeld. BEAM schrijft de definitieve inhoud voor de lancering.",
  "Ce texte est un exemple. BEAM rédige le contenu définitif avant le lancement.",
  "This text is a placeholder. BEAM writes the final content before launch.",
];

const desc = (subject: L3): L3 => [
  `${subject[0]} bij BEAM Vitality Center in Sint-Martens-Latem, een omgeving voor rust, herstel en energie.`,
  `${subject[1]} au BEAM Vitality Center à Sint-Martens-Latem, un environnement de repos, de récupération et d'énergie.`,
  `${subject[2]} at BEAM Vitality Center in Sint-Martens-Latem, an environment for rest, recovery and energy.`,
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

// ---------------------------------------------------------------------------
// Content of beam.be (captured 2026-11-15, docs/research/beam-be/), rebuilt as blocks. Prices are
// shown as text here because the demo catalogue (commerce seed) still carries placeholder prices.
// Testimonials quote public Google reviews; BEAM confirms consent before go-live (rule 21).
// ---------------------------------------------------------------------------

/** What a page builder gets: stable block ids, links to other seeded pages, catalogue product ids by SKU and media ids by key. */
type BuildCtx = { id: (part: string) => string; page: (slug: string) => Link; product: (sku: string) => string | undefined; media: (key: MediaKey) => string | undefined };

// ---------------------------------------------------------------------------
// Media: photos of beam.be (packages/db/src/seed/assets/beam/), public images in the media library.
// ---------------------------------------------------------------------------

const SITE_MEDIA = {
  hero: { file: "1920x800a.webp", alt: ["De BEAM-ruimte overdag: bedden, zetels en de EESystem-schermen voor grote ramen", "L'espace BEAM de jour : lits, fauteuils et écrans EESystem devant de grandes baies vitrées", "The BEAM space by day: beds, armchairs and the EESystem screens in front of large windows"] },
  day: { file: "16.-Onze-ruimte-480x500-2.webp", alt: ["Gasten rusten in zetels tijdens een dagsessie", "Des hôtes se reposent dans des fauteuils pendant une séance de jour", "Guests resting in armchairs during a day session"] },
  night: { file: "480x600-1.webp", alt: ["De BEAM-ruimte in warm avondlicht met meditatiekussens", "L'espace BEAM dans la lumière chaude du soir avec des coussins de méditation", "The BEAM space in warm evening light with meditation cushions"] },
  reception: { file: "Sessies-Hoe-haal-je-het-600-x-400.webp", alt: ["Gasten worden ontvangen aan het onthaal van BEAM", "Des hôtes accueillis à la réception de BEAM", "Guests welcomed at the BEAM reception"] },
  relax: { file: "Sessies-Tarieven-600-x-400.webp", alt: ["Een gast rust onder een deken naast de EESystem-schermen", "Une hôte se repose sous une couverture près des écrans EESystem", "A guest resting under a blanket next to the EESystem screens"] },
  room: { file: "13.-Onze-ruimte-480x250-1.webp", alt: ["Gasten in zetels in de BEAM-ruimte", "Des hôtes dans des fauteuils dans l'espace BEAM", "Guests in armchairs in the BEAM space"] },
  beds: { file: "15.-Onze-ruimte-360x500-1.webp", alt: ["Een rij bedden met warme dekens in de BEAM-ruimte", "Une rangée de lits avec des couvertures chaudes dans l'espace BEAM", "A row of beds with warm blankets in the BEAM space"] },
  founders: { file: "Technology-De-BEAM-installatie-500-x-600.webp", alt: ["De oprichters van BEAM in de ruimte", "Les fondateurs de BEAM dans l'espace", "The founders of BEAM in the space"] },
  community: { file: "De-waarde-van-dit-480x500px.webp", alt: ["De BEAM-community samen buiten", "La communauté BEAM réunie dehors", "The BEAM community together outside"] },
  events: { file: "group-meditation.webp", alt: ["Groepsmeditatie tijdens een BEAM-event", "Méditation de groupe lors d'un événement BEAM", "Group meditation at a BEAM event"] },
  corporate: { file: "Moderne-organisaties-opereren-600x400-1.webp", alt: ["Een team onder hoge druk op kantoor", "Une équipe sous forte pression au bureau", "A team under high pressure at the office"] },
  portrait: { file: "BEAM-dwingt-500-x-600.webp", alt: ["Een vrouw met gesloten ogen voor de EESystem-schermen", "Une femme les yeux fermés devant les écrans EESystem", "A woman with her eyes closed in front of the EESystem screens"] },
  location: { file: "6.-Onze-locatie-530x400-1.webp", alt: ["Het Latem Business Park, waar BEAM gevestigd is", "Le Latem Business Park, où se trouve BEAM", "The Latem Business Park, home of BEAM"] },
  cell: { file: "3-1.webp", alt: ["Illustratie van cellulaire elektriciteit over het celmembraan", "Illustration de l'électricité cellulaire à travers la membrane", "Illustration of cellular electricity across the cell membrane"] },
} as const satisfies Record<string, { file: string; alt: L3 }>;
type MediaKey = keyof typeof SITE_MEDIA;

/** Stores the seed photos as public image files and media assets (once: matched by sha256); returns media ids by key. */
async function seedSiteMedia(db: DbOrTx): Promise<(key: MediaKey) => string | undefined> {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "assets", "beam");
  const out = new Map<MediaKey, string>();
  for (const [key, m] of Object.entries(SITE_MEDIA) as [MediaKey, (typeof SITE_MEDIA)[MediaKey]][]) {
    let bytes: Buffer;
    try {
      bytes = await readFile(path.join(dir, m.file));
    } catch {
      continue; // a missing photo leaves the block without an image
    }
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const [existing] = await db.select({ id: mediaAssets.id }).from(mediaAssets).innerJoin(files, eq(files.id, mediaAssets.fileId)).where(eq(files.sha256, sha256));
    if (existing) {
      out.set(key, existing.id);
      continue;
    }
    const size = imageSize(new Uint8Array(bytes));
    if (!size) continue;
    const [file] = await db.insert(files).values({ kind: "image", name: m.file, mime: "image/webp", sizeBytes: bytes.length, bytes, sha256, isPublic: true }).returning({ id: files.id });
    const [asset] = await db.insert(mediaAssets).values({ fileId: file!.id, alt: txt(m.alt as unknown as L3), width: size.width, height: size.height, credit: "beam.be", source: "upload" }).returning({ id: mediaAssets.id });
    out.set(key, asset!.id);
  }
  return (key) => out.get(key);
}

/** A `pricing_table` of catalogue products, or null when one of them is not in the catalogue (then the page shows text). */
function priceCards(i: number, c: BuildCtx, key: string, heading: L3, skus: string[]): Block | null {
  const ids = skus.map((s) => c.product(s));
  if (ids.some((x) => !x)) return null;
  return { id: c.id(key), type: "pricing_table", heading: heading[i]!, productIds: ids as string[], showMemberPrice: false };
}
type Builder = (i: number, c: BuildCtx) => Block[];

/** Inline text with `**bold**` spans. */
function inline(s: string): RichTextNode[] {
  return s
    .split(/(\*\*[^*]+\*\*)/)
    .filter(Boolean)
    .map((part) => (part.startsWith("**") ? { type: "text" as const, text: part.slice(2, -2), marks: [{ type: "bold" as const }] } : { type: "text" as const, text: part }));
}

/** A rich-text part: an optional `h2` (or `h3`), paragraphs and a bullet list. */
type Part = { h?: L3; h3?: L3; p?: L3[]; list?: L3[] };

function doc(i: number, parts: Part[]): RichDoc {
  const content: RichBlockNode[] = [];
  for (const part of parts) {
    if (part.h) content.push({ type: "heading", attrs: { level: 2 }, content: inline(part.h[i]!) });
    if (part.h3) content.push({ type: "heading", attrs: { level: 3 }, content: inline(part.h3[i]!) });
    for (const p of part.p ?? []) content.push({ type: "paragraph", content: inline(p[i]!) });
    if (part.list?.length) content.push({ type: "bulletList", content: part.list.map((li) => ({ type: "listItem", content: [{ type: "paragraph", content: inline(li[i]!) }] })) });
  }
  return { type: "doc", content };
}

const rt = (i: number, c: BuildCtx, key: string, parts: Part[]): Block => ({ id: c.id(key), type: "rich_text", doc: doc(i, parts) });
const portal = (route: "book_day" | "book_night" | "home" | "membership" | "packages" | "bookings"): Link => ({ kind: "portal", route });
const hero = (i: number, c: BuildCtx, heading: L3, sub: L3, cta?: { label: L3; link: Link }, img?: MediaKey): Block => {
  const mediaId = img ? c.media(img) : undefined;
  return {
    id: c.id("hero"),
    type: "hero",
    heading: heading[i]!,
    subheading: sub[i]!,
    ...(mediaId ? { mediaId } : {}),
    ...(cta ? { cta: { label: cta.label[i]!, link: cta.link } } : {}),
  };
};
type CardSeed = { h: L3; t: L3; link?: Link; img?: MediaKey };
const cards = (i: number, c: BuildCtx, key: string, heading: L3 | null, list: CardSeed[], layout?: "cards" | "list" | "split"): Block => ({
  id: c.id(key),
  type: "card_grid",
  ...(heading ? { heading: heading[i]! } : {}),
  ...(layout ? { layout } : {}),
  cards: list.map((x) => {
    const mediaId = x.img ? c.media(x.img) : undefined;
    return { heading: x.h[i]!, text: x.t[i]!, ...(mediaId ? { mediaId } : {}), ...(x.link ? { link: x.link } : {}) };
  }),
});
const book = (i: number, c: BuildCtx, key: string, label: L3, target: { kind: "book_day" } | { kind: "book_night" } | { kind: "gift" }, note?: L3): Block => ({
  id: c.id(key),
  type: "booking_cta",
  label: label[i]!,
  ...(note ? { note: note[i]! } : {}),
  target,
});
/** Text beside a photo; plain rich text when the photo is not in the media library. */
const imageText = (i: number, c: BuildCtx, key: string, img: MediaKey, side: "left" | "right", parts: Part[]): Block => {
  const mediaId = c.media(img);
  return mediaId ? { id: c.id(key), type: "image_text", mediaId, imageSide: side, doc: doc(i, parts) } : rt(i, c, key, parts);
};
const cta = (i: number, c: BuildCtx, key: string, heading: L3, body: L3, label: L3, link: Link): Block => ({ id: c.id(key), type: "cta", heading: heading[i]!, text: body[i]!, button: { label: label[i]!, link } });
const faq = (i: number, c: BuildCtx, key: string, heading: L3, items: { q: L3; a: L3[] }[]): Block => ({
  id: c.id(key),
  type: "faq",
  heading: heading[i]!,
  items: items.map((x) => ({ question: x.q[i]!, answer: doc(i, [{ p: x.a }]) })),
});
/**
 * Real Google reviews of BEAM (5 stars, captured from beam.be's Trustindex widget on 2026-11-15),
 * quoted verbatim in their own language on every locale. BEAM confirms consent before go-live (rule 21).
 */
const GOOGLE_REVIEWS: { q: string; a: string; date: L3 }[] = [
  {
    q: "Zodra je het Beam Vitality Center binnenstapt, kom je terecht in een bad vol liefde. Alles ademt er zachtheid, licht, liefde en heel fijne energie... Een spirituele quote, een zacht dekentje, de mandala’s, prachtige mineralen... zorgen voor een warme sfeer. Maar vooral de hartelijke ontvangst en de passie van Sanne, Christophe en Jonathan maken van ieder bezoek een bijzondere ervaring. Tijdens een meditatie op een zitkussen of een sessie in een comfortabele zetel kan je in alle stilte en rust genieten van de helende frequenties die je in een heel diepe ontspanning brengen. Een ware boost voor ‘My energy. My life.’ Achteraf kan je bij een heerlijk theetje nog even napraten met andere bezoekers om daarna opgeladen met vernieuwde energie terug naar buiten te stappen. Een voorrecht om hiervan te mogen genieten. Zalig!",
    a: "Hilde Desmet",
    date: ["29 juni 2026", "29 juin 2026", "29 June 2026"],
  },
  {
    q: "💛BEAM staat voor mij gelijk aan thuiskomen. Opnieuw voeling krijgen met wie ik in wezen ben, op adem komen, rust vinden en energie tanken. In de ratrace van het leven een welgekomen oase.💛",
    a: "Sara Verhasselt",
    date: ["14 juli 2026", "14 juillet 2026", "14 July 2026"],
  },
  {
    q: "Every time I visit my body goes into a deep state of rest and relaxation. Sanne, Christophe and Jonathan are super nice and always make everyone feel at home. Just give it a try and feel for yourself what it does.",
    a: "George",
    date: ["2 juli 2026", "2 juillet 2026", "2 July 2026"],
  },
  {
    q: "Wat een inspirerende en rustgevende plek. Ik had alweer het genoegen om een intense babbel met Christophe te hebben. Ik hield tonnen energie én een mantra (die ik elke dag herhaal) over aan mijn bezoek.",
    a: "Jits Van Belle",
    date: ["11 augustus 2026", "11 août 2026", "11 August 2026"],
  },
];

/** Consecutive testimonial blocks render as one Google-review section. */
const reviews = (i: number, c: BuildCtx, key: string, count = GOOGLE_REVIEWS.length): Block[] =>
  GOOGLE_REVIEWS.slice(0, count).map((r, n) => ({ id: c.id(`${key}-${n}`), type: "testimonial", quote: r.q, authorName: r.a, authorDetail: r.date[i]!, consentConfirmed: true }));

const BOOK: L3 = ["Boek je sessie", "Réservez votre séance", "Book your session"];
const L_DAY: L3 = ["Dagsessie boeken", "Réserver une séance de jour", "Book a day session"];
const L_NIGHT: L3 = ["Nachtsessie boeken", "Réserver une séance de nuit", "Book a night session"];
const L_GIFT: L3 = ["Cadeaubon geven", "Offrir un bon cadeau", "Give a gift voucher"];

const SCHEDULE: Part = {
  h: ["Dagsessies", "Séances de jour", "Day sessions"],
  p: [["Elke dag drie sessies van **2 uur**, behalve op dinsdag en woensdag:", "Chaque jour trois séances de **2 heures**, sauf le mardi et le mercredi :", "Three **2-hour** sessions every day, except Tuesday and Wednesday:"]],
  list: [
    ["Van 10 tot 12 uur", "De 10 h à 12 h", "10:00 to 12:00"],
    ["Van 13 tot 15 uur (zaterdag: kindersessie)", "De 13 h à 15 h (samedi : séance enfants)", "13:00 to 15:00 (Saturday: children's session)"],
    ["Van 16 tot 18 uur (maandag: huisdieren welkom)", "De 16 h à 18 h (lundi : animaux bienvenus)", "16:00 to 18:00 (Monday: pets welcome)"],
  ],
};

const FAQ_SESSIONS = [
  { q: ["Hoe lang duurt een sessie?", "Combien de temps dure une séance ?", "How long does a session last?"] as L3, a: [["Een standaardsessie duurt 2 uur. Nachtsessies duren 12 uur, van 20 tot 8 uur.", "Une séance standard dure 2 heures. Les séances de nuit durent 12 heures, de 20 h à 8 h.", "A standard session lasts 2 hours. Night sessions last 12 hours, from 20:00 to 08:00."] as L3] },
  { q: ["Hoeveel mensen zijn er aanwezig?", "Combien de personnes sont présentes ?", "How many people take part?"] as L3, a: [["Aan dagsessies nemen tot 14 personen deel. Nachtsessies zijn beperkt tot 8 personen voor het comfort.", "Jusqu'à 14 personnes participent aux séances de jour. Les séances de nuit sont limitées à 8 personnes pour le confort.", "Up to 14 people join a day session. Night sessions are limited to 8 people for comfort."] as L3] },
  { q: ["Dag- of nachtsessie?", "Séance de jour ou de nuit ?", "Day or night session?"] as L3, a: [["Beide gebruiken dezelfde ruimte. Dagsessies zijn toegankelijker voor een eerste bezoek; 's nachts blijf je langer ononderbroken in de ruimte terwijl je lichaam rust.", "Les deux utilisent le même espace. Les séances de jour sont plus accessibles pour une première visite ; la nuit, vous restez plus longtemps sans interruption pendant que votre corps se repose.", "Both use the same space. Day sessions are easier for a first visit; at night you stay longer without interruption while your body rests."] as L3] },
  { q: ["Mag ik mijn pakket delen?", "Puis-je partager mon forfait ?", "Can I share my package?"] as L3, a: [["Ja, pakketten kunnen met maximaal vijf personen worden gedeeld en blijven 18 maanden geldig.", "Oui, les forfaits se partagent avec cinq personnes maximum et restent valables 18 mois.", "Yes, packages can be shared by up to five people and stay valid for 18 months."] as L3] },
];

const FAQ_PRACTICAL = [
  { q: ["Welke kledij raden jullie aan?", "Quelle tenue recommandez-vous ?", "What should I wear?"] as L3, a: [["Comfortabele kleding. Het doel is dat je lichaam volledig kan ontspannen.", "Des vêtements confortables. Le but est que votre corps puisse se détendre complètement.", "Comfortable clothing. The aim is to let your body relax completely."] as L3] },
  { q: ["Hoe bereid ik me voor?", "Comment me préparer ?", "How do I prepare?"] as L3, a: [["Kom indien mogelijk uitgerust aan en drink voldoende water. Een specifieke voorbereiding is niet nodig.", "Arrivez reposé si possible et buvez suffisamment d'eau. Aucune préparation particulière n'est nécessaire.", "Arrive rested if you can and drink enough water. No specific preparation is needed."] as L3] },
  { q: ["Wat doe ik na een sessie?", "Que faire après une séance ?", "What do I do after a session?"] as L3, a: [["Neem tijd voor rust en herstel en denk aan een zoutbad. Voldoende drinken en een rustig tempo ondersteunen je ervaring.", "Prenez le temps de vous reposer et pensez à un bain de sel. Boire suffisamment et garder un rythme calme prolongent l'expérience.", "Take time to rest and consider a salt bath. Drinking enough water and keeping a calm pace support the experience."] as L3] },
  { q: ["Mag ik mijn kind of huisdier meenemen?", "Puis-je venir avec mon enfant ou mon animal ?", "Can I bring my child or pet?"] as L3, a: [["Kinderen zijn welkom op zaterdag van 13 tot 15 uur, huisdieren op maandag van 16 tot 18 uur. Laat het ons vooraf weten.", "Les enfants sont les bienvenus le samedi de 13 h à 15 h, les animaux le lundi de 16 h à 18 h. Prévenez-nous à l'avance.", "Children are welcome on Saturdays from 13:00 to 15:00, pets on Mondays from 16:00 to 18:00. Please let us know in advance."] as L3] },
  { q: ["Is er parking en is de ruimte toegankelijk?", "Y a-t-il un parking et l'espace est-il accessible ?", "Is there parking and is the space accessible?"] as L3, a: [["Er zijn enkele parkeerplaatsen op het terrein en gratis openbare parkeerplaatsen vlakbij. De ruimte is rolstoelvriendelijk; neem vooraf contact op.", "Quelques places de parking sur le site et un parking public gratuit à proximité. L'espace est accessible en fauteuil roulant ; contactez-nous à l'avance.", "There are a few parking spaces on site and free public parking nearby. The space is wheelchair friendly; please contact us in advance."] as L3] },
];

const FAQ_TECH = [
  { q: ["Wat is het Energy Enhancement System™?", "Qu'est-ce que l'Energy Enhancement System™ ?", "What is the Energy Enhancement System™?"] as L3, a: [["Een niet-invasieve technologie die in de BEAM-ruimte is geïntegreerd en bijdraagt aan stabiele, coherente omgevingscondities.", "Une technologie non invasive intégrée à l'espace BEAM qui contribue à des conditions ambiantes stables et cohérentes.", "A non-invasive technology built into the BEAM space that contributes to stable, coherent environmental conditions."] as L3] },
  { q: ["Hoeveel units staan er bij BEAM?", "Combien d'unités compte BEAM ?", "How many units does BEAM have?"] as L3, a: [["48 gesynchroniseerde units: een van de grootste coherente EESystem-omgevingen in Europa.", "48 unités synchronisées : l'un des plus grands environnements EESystem cohérents d'Europe.", "48 synchronised units: one of the largest coherent EESystem environments in Europe."] as L3] },
  { q: ["Is dit een vervanging voor medische zorg?", "Est-ce un substitut aux soins médicaux ?", "Does this replace medical care?"] as L3, a: [["Nee. BEAM stelt geen diagnoses, behandelt niet en vervangt geen medische zorg.", "Non. BEAM ne pose pas de diagnostic, ne traite pas et ne remplace pas les soins médicaux.", "No. BEAM does not diagnose, treat or replace medical care."] as L3] },
  { q: ["Moet ik erin geloven?", "Faut-il y croire ?", "Do I have to believe in it?"] as L3, a: [["Nee, de omgeving functioneert onafhankelijk van persoonlijke overtuigingen.", "Non, l'environnement fonctionne indépendamment des convictions personnelles.", "No, the environment works regardless of personal beliefs."] as L3] },
];

const DAY_NOTE: L3 = ["2 uur · €120", "2 heures · 120 €", "2 hours · €120"];
const NIGHT_NOTE: L3 = ["12 uur · €420", "12 heures · 420 €", "12 hours · €420"];
const GIFT_NOTE: L3 = ["Vanaf €25 · 2 jaar geldig", "Dès 25 € · valable 2 ans", "From €25 · valid 2 years"];

/** Story text: the heading stands beside the text; long text continues behind "read more". */
const chapter = (i: number, c: BuildCtx, key: string, parts: Part[]): Block => ({ id: c.id(key), type: "rich_text", variant: "chapter", doc: doc(i, parts) });
/** One or two big lines on a navy band with the gold wave. */
const statement = (i: number, c: BuildCtx, key: string, lines: L3[]): Block => ({ id: c.id(key), type: "rich_text", variant: "statement", doc: doc(i, [{ p: lines }]) });
/** A vertical video (YouTube Short) beside its text; a story chapter when the poster photo is not in the media library. */
const videoStory = (i: number, c: BuildCtx, key: string, youtubeId: string, title: L3, poster: MediaKey, parts: Part[]): Block => {
  const posterMediaId = c.media(poster);
  return posterMediaId ? { id: c.id(key), type: "video", youtubeId, title: title[i]!, posterMediaId, portrait: true, doc: doc(i, parts) } : chapter(i, c, key, parts);
};
type CardIcon = NonNullable<Extract<Block, { type: "card_grid" }>["cards"][number]["icon"]>;
/** Cards with a gold brand icon of beam.be. */
const iconCards = (i: number, c: BuildCtx, key: string, heading: L3 | null, list: { h: L3; t: L3; icon: CardIcon; link?: Link }[]): Block => ({
  id: c.id(key),
  type: "card_grid",
  layout: "icons",
  ...(heading ? { heading: heading[i]! } : {}),
  cards: list.map((x) => ({ heading: x.h[i]!, text: x.t[i]!, icon: x.icon, ...(x.link ? { link: x.link } : {}) })),
});

/**
 * The home page tells the whole story of beam.be's home (nl and en verbatim, fr translated; the
 * coverage test `site.home-coverage.test.ts` fails when a line of it goes missing), presented as
 * chapters, statement bands and icon cards, with the booking tiles, live availability and reviews
 * of the platform around it.
 */
const HOME: Builder = (i, c) => [
  hero(i, c, ["BEAM is een fundament voor menselijke energie", "BEAM, une fondation pour l'énergie humaine", "BEAM is an infrastructure for human energy"], [
    "Een omgeving doelbewust ontworpen voor rust, herstel en balans. Europa's grootste 48-unit EESystem-installatie, in Sint-Martens-Latem bij Gent.",
    "Un environnement conçu pour le repos, la récupération et l'équilibre. La plus grande installation EESystem de 48 unités d'Europe, à Sint-Martens-Latem près de Gand.",
    "An environment specifically created for rest, recovery and balance. Europe's largest 48-unit EESystem installation, in Sint-Martens-Latem near Ghent.",
  ], { label: BOOK, link: portal("book_day") }, "hero"),
  book(i, c, "quick-day", L_DAY, { kind: "book_day" }, DAY_NOTE),
  book(i, c, "quick-night", L_NIGHT, { kind: "book_night" }, NIGHT_NOTE),
  book(i, c, "quick-gift", L_GIFT, { kind: "gift" }, GIFT_NOTE),
  videoStory(i, c, "discover", "N58VfO6zlRQ", ["BEAM Vitality Center in minder dan 1 minuut", "BEAM Vitality Center en moins d'une minute", "BEAM Vitality Center in less than 1 minute"], "night", [{
    h: ["**Ontdek BEAM** in minder dan 1 minuut", "**Découvrez BEAM** en moins d'une minute", "**Discover BEAM** in less than 1 minute"],
    p: [[
      "In minder dan 1 minuut ontdek je de unieke omgeving die we hebben gecreëerd voor rust, herstel en balans. Een plek waar je loskomt van constante prikkels en druk en weer helemaal kan opladen.",
      "En moins d'une minute, découvrez l'environnement unique que nous avons créé pour le repos, la récupération et l'équilibre. Un lieu où vous vous libérez des sollicitations et de la pression constantes pour vous recharger pleinement.",
      "In less than a minute, you’ll discover the unique environment we’ve created for peace, recovery, and balance. A place where you can escape the constant stimuli and pressures and fully recharge.",
    ]],
  }]),
  statement(i, c, "statement-energy", [
    ["Je energie is je **grootste goed**.", "Votre énergie est votre **bien le plus précieux**.", "Your energy is your **greatest asset**."],
    ["Alles in het leven hangt ervan af.", "Tout dans la vie en dépend.", "Everything in life depends on it."],
  ]),
  imageText(i, c, "intro", "portrait", "right", [{
    h: ["**Menselijke energie** is structureel **uitgeput**", "L'**énergie humaine** est structurellement **épuisée**", "**Human energy** is structurally **depleted**"],
    p: [
      ["**BEAM werkt aan de bron, op het niveau waar capaciteit ontstaat.**", "**BEAM agit à la source, au niveau où naît la capacité.**", "**BEAM operates upstream, at the level where capacity begins.**"],
      ["Je kent het wel. Vermoeidheid die je niet weg kunt slapen. De moeite die het kost om na een lange dag nog helder te denken. Het gevoel dat je wel functioneert, maar niet helemaal op jouw niveau.", "Vous connaissez ça. Une fatigue que le sommeil n'efface pas. L'effort qu'il faut pour penser clairement après une longue journée. Le sentiment de fonctionner, mais pas tout à fait à votre niveau.", "You know the feeling. The tiredness that sleep does not fix. The effort it takes to think clearly after a long day. The sense that you are functioning — but not quite at the level you know you are capable of."],
      ["Dit is geen zwakte. Het is geen gebrek aan motivatie of discipline. Het is wat er gebeurt wanneer de eisen aan het menselijk systeem structureel groter zijn dan het vermogen om te herstellen.", "Ce n'est pas une faiblesse. Ce n'est pas un manque de motivation ou de discipline. C'est ce qui arrive quand les exigences imposées au système humain dépassent durablement sa capacité de récupération.", "This is not weakness. It is not a lack of motivation or discipline. It is what happens when the demands placed on the human system consistently outpace its capacity to restore itself."],
      ["Het moderne leven is niet ontworpen met het oog op herstel. Het resultaat is een groeiende kloof tussen wat van mensen wordt gevraagd en wat ze werkelijk nog kunnen geven.", "La vie moderne n'a pas été conçue pour la récupération. Il en résulte un écart croissant entre ce que l'on demande aux gens et ce qu'ils peuvent réellement encore donner.", "Modern life was not designed with restoration in mind. The result is a growing gap between what people are asked to give and what they genuinely have available."],
    ],
  }]),
  chapter(i, c, "condition", [{
    h: ["Energie is geen **concept**. Het is een **voorwaarde** om te kunnen functioneren.", "L'énergie n'est pas un **concept**. C'est une **condition** pour fonctionner.", "Energy is not a **concept**. It is a **condition** for functioning."],
    p: [
      ["Energie is geen metafoor. Het is de basisvoorwaarde voor helderheid, veerkracht en effectief functioneren.", "L'énergie n'est pas une métaphore. C'est la condition de base de la clarté, de la résilience et d'un fonctionnement efficace.", "Energy is not a metaphor. It is the precondition for clarity, resilience, and effective functioning."],
      ["Wanneer je energie weer op peil is, denk je helderder, herstel je beter en ben je stabieler.", "Quand votre énergie est restaurée, vous pensez plus clairement, vous récupérez mieux et vous êtes plus stable.", "When energy is restored, people think more clearly, recover more fully, and function more steadily."],
    ],
  }]),
  chapter(i, c, "principle", [{
    h: ["**BEAM is geen behandeling.** Het is een omgeving die ontworpen is om herstel mogelijk te maken.", "**BEAM n'est pas un traitement.** C'est un environnement conçu pour rendre la récupération possible.", "**BEAM is not a treatment.** It is an environment designed for restoration."],
    p: [
      ["**BEAM is gebaseerd op één principe: Menselijke systemen herstellen zich wanneer de omgeving dat toelaat.**", "**BEAM repose sur un principe : les systèmes humains se rétablissent lorsque l'environnement le permet.**", "**BEAM is built around one principle: Human systems restore when the environment allows them to.**"],
      [
        "Biologische systemen reageren voortdurend op hun omgeving. Wanneer die omgeving gefragmenteerd en belastend is, moet het lichaam blijven compenseren. Maar wanneer die omgeving rustiger en coherenter wordt, kan het zenuwstelsel zich anders beginnen gedragen. Regulatie wordt toegankelijker. Herstel wordt mogelijk. Dit proces verloopt via resonantie, de natuurlijke neiging van biologische systemen om zich af te stemmen op coherente externe signalen. Er is geen inspanning vereist. Het lichaam volgt vanzelf.",
        "Les systèmes biologiques réagissent en permanence à leur environnement. Quand cet environnement est fragmenté et éprouvant, le corps doit sans cesse compenser. Mais quand il devient plus calme et plus cohérent, le système nerveux peut commencer à se comporter autrement. La régulation devient plus accessible. La récupération devient possible. Ce processus passe par la résonance, la tendance naturelle des systèmes biologiques à s'accorder à des signaux extérieurs cohérents. Aucun effort n'est requis. Le corps suit de lui-même.",
        "Biological systems continuously respond to the environments they inhabit. When the environment becomes coherent and stable, the nervous system can regulate more efficiently. This process operates through resonance, the natural tendency of biological systems to attune to coherent external signals. No effort is required. The body simply follows.",
      ],
      [
        "Bij BEAM creëren we omgevingen die deze voorwaarden ondersteunen. Rustig, intentioneel en coherent. Er wordt niets van je verwacht. Je hoeft geen methode toe te passen of techniek onder de knie te krijgen. Je betreedt gewoon een ruimte die is ontworpen om tot rust te komen en te herstellen.",
        "Chez BEAM, nous créons des environnements qui soutiennent ces conditions. Calmes, intentionnels et cohérents. Rien n'est attendu de vous. Aucune méthode à appliquer, aucune technique à maîtriser. Vous entrez simplement dans un espace conçu pour se poser et récupérer.",
        "We create calm, intentional and coherent environments that support regulation, recovery and sustained vitality. Nothing is required from you. There is no method to apply and no technique to master. You simply enter a space designed for restoration.",
      ],
    ],
  }]),
  iconCards(i, c, "principles", null, [
    { icon: "ees", h: ["Energy Enhancement System™", "Energy Enhancement System™", "Energy Enhancement System™"], t: ["Geïntegreerd in een zorgvuldig vormgegeven setting die fysiologische stabiliteit ondersteunt.", "Intégré dans un cadre soigneusement conçu qui soutient la stabilité physiologique.", "Integrated as part of a carefully structured setting that supports physiological stability."], link: c.page("technology") },
    { icon: "technology", h: ["Technologie ten dienste van de omgeving", "La technologie au service de l'environnement", "Technology in service of the environment"], t: ["Niet andersom. In plaats van in te grijpen op het lichaam, draagt de technologie bij aan de omstandigheden eromheen.", "Et non l'inverse. Plutôt que d'agir sur le corps, la technologie contribue aux conditions qui l'entourent.", "The technology does not act on the body. It contributes to the conditions surrounding it. Not the other way around."], link: c.page("environment") },
    { icon: "energy_first", h: ["Energie eerst", "L'énergie d'abord", "Energy first"], t: ["BEAM ondersteunt energie op het niveau waar menselijk functioneren begint: vóór prestatie, gedrag of output.", "BEAM soutient l'énergie là où commence le fonctionnement humain : avant la performance, le comportement ou le résultat.", "BEAM supports energy at the level where human functioning begins — before performance, behaviour or output."], link: c.page("about") },
  ]),
  statement(i, c, "statement-foundation", [[
    "BEAM legt het **fundament** voor je energie, zodat alles wat daarna komt **beter** functioneert.",
    "BEAM pose les **fondations** de votre énergie, pour que tout ce qui suit fonctionne **mieux**.",
    "BEAM **supports energy first**, so everything else can **function better**.",
  ]]),
  chapter(i, c, "audience", [{
    h: ["Voor wie BEAM bedoeld is", "À qui s'adresse BEAM", "Who BEAM is for"],
    p: [
      ["BEAM is bedoeld voor mensen en organisaties die beseffen dat **energie de basis vormt van alles**.", "BEAM s'adresse aux personnes et aux organisations qui savent que **l'énergie est à la base de tout**.", "BEAM is for people and organisations who recognise that **energy is foundational**."],
      ["BEAM is niet gebouwd voor snelle oplossingen of oppervlakkige optimalisatie. Het is bedoeld voor mensen die meer waarde hechten aan duurzaamheid dan aan intensiteit.", "BEAM n'est pas conçu pour les solutions rapides ni pour l'optimisation de surface. Il s'adresse à celles et ceux qui privilégient la durabilité à l'intensité.", "BEAM is not built for quick fixes or surface optimisation. It is built for those who value infrastructure over intensity."],
    ],
  }]),
  iconCards(i, c, "audiences", null, [
    { icon: "individuals", h: ["Particulieren", "Particuliers", "Individuals"], t: ["Zij beseffen dat uitputting de norm is geworden, en weten dat dit niet zo hoort te zijn.", "Ils constatent que l'épuisement est devenu la norme, et savent que cela ne devrait pas être le cas.", "Who recognise that exhaustion has become normal — and know it should not be."] },
    { icon: "professionals", h: ["Professionals", "Professionnels", "Professionals"], t: ["Zij hebben te maken met langdurige verantwoordelijkheid en cognitieve belasting.", "Ils portent une responsabilité durable et une forte charge cognitive.", "Managing sustained responsibility and cognitive load."] },
    { icon: "leaders", h: ["Leidinggevenden", "Dirigeants", "Leaders"], t: ["Zij begrijpen dat duurzame prestaties energie vereisen i.p.v. extra druk.", "Ils comprennent que la performance durable exige de l'énergie, pas davantage de pression.", "Who understand that long-term performance requires energy, not pressure."] },
    { icon: "organisations", h: ["Organisaties", "Organisations", "Organisations"], t: ["Zij erkennen dat menselijke energie even essentieel is als kapitaal, talent of strategie.", "Elles reconnaissent que l'énergie humaine est aussi essentielle que le capital, le talent ou la stratégie.", "Recognising that human energy is as fundamental as capital, talent and strategy."] },
  ]),
  cards(i, c, "day-night", ["Ervaring & praktische informatie", "Expérience & informations pratiques", "Experience & practical information"], [
    {
      h: ["Dagsessies", "Séances de jour", "Day sessions"],
      t: [
        "Er zijn dagelijks drie sessies beschikbaar van telkens 2 uur tussen 10 en 18 uur (behalve op dinsdag en woensdag): van 10 tot 12 uur, van 13 tot 15 uur en van 16 tot 18 uur. Kinderen zijn welkom op zaterdag van 13 tot 15 uur. Huisdieren zijn welkom op maandag van 16 tot 18 uur.",
        "Trois séances de 2 heures sont proposées chaque jour entre 10 h et 18 h (sauf le mardi et le mercredi) : de 10 h à 12 h, de 13 h à 15 h et de 16 h à 18 h. Les enfants sont les bienvenus le samedi de 13 h à 15 h. Les animaux sont les bienvenus le lundi de 16 h à 18 h.",
        "Three 2-hour sessions are available daily (except Tuesday and Wednesday) between 10am and 6pm: from 10am to 12pm, from 1pm to 3pm and from 4pm to 6pm. Children are welcome on Saturday from 1pm to 3pm. Pets may join on Monday from 4pm to 6pm.",
      ],
      link: c.page("day-sessions"),
      img: "day",
    },
    {
      h: ["Nachtsessies", "Séances de nuit", "Night sessions"],
      t: [
        "Van woensdag tot en met zondag zijn er nachtsessies waarbij je 12 uur in onze ruimte vertoeft, van 20 uur tot 8 uur. Je komt tot rust in een kalme en premium setting in de BEAM-ruimte, terwijl de stabiele en coherente omgevingscondities de hele nacht behouden blijven.",
        "Du mercredi au dimanche, des séances de nuit vous accueillent 12 heures dans notre espace, de 20 h à 8 h. Vous vous reposez dans un cadre calme et haut de gamme, tandis que des conditions stables et cohérentes sont maintenues toute la nuit.",
        "Overnight sessions of 12 hours are available from Wednesday to Sunday, from 8pm to 8am. You rest in a calm, private setting within the BEAM environment while stable and coherent conditions are maintained throughout the night.",
      ],
      link: c.page("nights"),
      img: "night",
    },
  ], "split"),
  { id: c.id("availability-day"), type: "availability_preview", kind: "day", days: 7 },
  { id: c.id("availability-night"), type: "availability_preview", kind: "night", days: 7 },
  cards(i, c, "more", ["Meer van BEAM", "Plus de BEAM", "More from BEAM"], [
    {
      h: ["Pakketten", "Forfaits", "Packages"],
      t: [
        "Voor iedereen die kiest voor duurzaam herstel bieden wij pakketten aan van 10 tot 100 uur tegen voordelige tarieven. Deze pakketten kunnen door maximaal vijf personen worden gedeeld en blijven 18 maanden geldig.",
        "Pour celles et ceux qui choisissent une récupération durable, nous proposons des forfaits de 10 à 100 heures à des tarifs avantageux. Ils peuvent être partagés par cinq personnes au maximum et restent valables 18 mois.",
        "For those committed to sustained restoration, we offer packages ranging from 10 to 100 hours at preferred rates. Packages may be shared by up to five people and remain valid for 18 months.",
      ],
      link: c.page("pricing"),
      img: "relax",
    },
    { h: ["Membership", "Membership", "Membership"], t: ["€396 per jaar: een gratis nacht, tot 20% korting en events voor leden.", "396 € par an : une nuit offerte, jusqu'à 20 % de réduction et des rencontres membres.", "€396 a year: a free night, up to 20% off and members-only gatherings."], link: c.page("memberships"), img: "community" },
    {
      h: ["Voor particulieren en bedrijven", "Pour les particuliers et les entreprises", "Private & corporate experiences"],
      t: [
        "Voor privé-sessies, incentives of groepservaringen op maat, kan je rechtstreeks met ons contact opnemen. We bekijken dan samen met jou wat het beste aansluit bij jouw wensen.",
        "Pour des séances privées, des incentives ou des expériences de groupe sur mesure, contactez-nous directement. Nous verrons ensemble ce qui correspond le mieux à vos souhaits.",
        "For private sessions, incentives, or tailored group experiences, please contact us directly. We are happy to explore what fits your needs.",
      ],
      link: c.page("corporate"),
      img: "reception",
    },
  ]),
  ...reviews(i, c, "review"),
  { id: c.id("events"), type: "events_list", heading: ["Komende events", "Événements à venir", "Upcoming events"][i]!, limit: 3, showFull: true },
  cta(i, c, "cta", ["Klaar om op te laden?", "Prêt à vous ressourcer ?", "Ready to recharge?"], ["Kom tot rust in de grootste EESystem-ruimte van Europa.", "Venez vous ressourcer dans le plus grand espace EESystem d'Europe.", "Come and recharge in Europe's largest EESystem space."], BOOK, portal("book_day")),
];

const DAY_INTRO: Part = { p: [["Een sessie bij BEAM duurt **2 uur**. Je komt tot rust in een stille, coherente ruimte. Er wordt niets van je verwacht: je kunt rusten, lezen of gewoon zijn.", "Une séance chez BEAM dure **2 heures**. Vous vous détendez dans un espace calme et cohérent. Rien n'est attendu de vous : vous pouvez vous reposer, lire ou simplement être.", "A session at BEAM lasts **2 hours**. You unwind in a quiet, coherent space. Nothing is expected of you: rest, read or simply be."]] };
const KIDS_NOTE: L3 = ["Kinderen onder 12 jaar komen gratis mee met een ouder. Twee opeenvolgende sessies? Het uur ertussen is gratis.", "Les enfants de moins de 12 ans viennent gratuitement avec un parent. Deux séances consécutives ? L'heure entre les deux est offerte.", "Children under 12 come free with a parent. Two sessions in a row? The hour in between is free."];
const L_SINGLE: L3 = ["Losse sessies", "Séances à l'unité", "Single sessions"];
const L_HOURS: L3 = ["Urenpakketten", "Forfaits d'heures", "Hour packages"];
const L_NIGHTS: L3 = ["Nachtpakketten", "Forfaits de nuits", "Night packages"];

const DAY_SESSIONS: Builder = (i, c) => {
  const cards = priceCards(i, c, "prices", L_SINGLE, [BEAM_SKUS.dayAdult, BEAM_SKUS.dayYouth]);
  const packs = priceCards(i, c, "packages", L_HOURS, [BEAM_SKUS.hours10, BEAM_SKUS.hours20, BEAM_SKUS.hours30]);
  if (cards && packs) {
    return [
      rt(i, c, "text", [DAY_INTRO, SCHEDULE, { p: [KIDS_NOTE] }]),
      cards,
      packs,
      book(i, c, "book", L_DAY, { kind: "book_day" }),
      { id: c.id("availability"), type: "availability_preview", kind: "day", days: 7 },
      faq(i, c, "faq", ["Goed om te weten", "Bon à savoir", "Good to know"], FAQ_SESSIONS),
    ];
  }
  return DAY_SESSIONS_TEXT(i, c);
};

const DAY_SESSIONS_TEXT: Builder = (i, c) => [
  rt(i, c, "text", [
    DAY_INTRO,
    SCHEDULE,
    {
      h: ["Prijzen", "Tarifs", "Prices"],
      list: [
        ["Volwassenen: **€120** per sessie (€60 per uur)", "Adultes : **120 €** par séance (60 € de l'heure)", "Adults: **€120** per session (€60 an hour)"],
        ["Jongeren 12-18 jaar, samen met een volwassene: **€60**", "Jeunes de 12 à 18 ans, avec un adulte : **60 €**", "Young people aged 12-18, with an adult: **€60**"],
        ["Kinderen onder 12 jaar, samen met een ouder: **gratis**", "Enfants de moins de 12 ans, avec un parent : **gratuit**", "Children under 12, with a parent: **free**"],
        ["Huisdier (maandag 16-18 uur): **€20**", "Animal (lundi 16 h-18 h) : **20 €**", "Pet (Monday 16:00-18:00): **€20**"],
      ],
      p: [["Twee opeenvolgende sessies? Het uur ertussen is gratis.", "Deux séances consécutives ? L'heure entre les deux est offerte.", "Two sessions in a row? The hour in between is free."]],
    },
  ]),
  book(i, c, "book", L_DAY, { kind: "book_day" }),
  { id: c.id("availability"), type: "availability_preview", kind: "day", days: 7 },
  faq(i, c, "faq", ["Goed om te weten", "Bon à savoir", "Good to know"], FAQ_SESSIONS),
];

const NIGHT_INTRO: Part = { p: [["Van woensdag tot en met zondag verblijf je **12 uur** in de BEAM-ruimte, van 20 uur tot 8 uur. Je rust in een kalme, premium setting terwijl de stabiele en coherente omgevingscondities de hele nacht behouden blijven. Nachtsessies zijn beperkt tot 8 personen.", "Du mercredi au dimanche, vous passez **12 heures** dans l'espace BEAM, de 20 h à 8 h. Vous vous reposez dans un cadre calme et premium, tandis que les conditions stables et cohérentes sont maintenues toute la nuit. Les séances de nuit sont limitées à 8 personnes.", "Wednesday to Sunday you stay **12 hours** in the BEAM space, from 20:00 to 08:00. You rest in a calm, premium setting while the stable, coherent conditions are kept all night. Night sessions are limited to 8 people."]] };

const NIGHTS: Builder = (i, c) => {
  const cards = priceCards(i, c, "prices", L_SINGLE, [BEAM_SKUS.nightAdult, BEAM_SKUS.nightYouth]);
  const packs = priceCards(i, c, "packages", L_NIGHTS, [BEAM_SKUS.nights3, BEAM_SKUS.nights5, BEAM_SKUS.nights10]);
  if (cards && packs) {
    return [
      rt(i, c, "text", [NIGHT_INTRO]),
      cards,
      packs,
      book(i, c, "book", L_NIGHT, { kind: "book_night" }),
      { id: c.id("availability"), type: "availability_preview", kind: "night", days: 14 },
    ];
  }
  return NIGHTS_TEXT(i, c);
};

const NIGHTS_TEXT: Builder = (i, c) => [
  rt(i, c, "text", [
    NIGHT_INTRO,
    {
      h: ["Prijzen", "Tarifs", "Prices"],
      list: [
        ["Volwassenen: **€420** per nacht (€35 per uur)", "Adultes : **420 €** par nuit (35 € de l'heure)", "Adults: **€420** per night (€35 an hour)"],
        ["Jongeren 12-18 jaar: **€210**", "Jeunes de 12 à 18 ans : **210 €**", "Young people aged 12-18: **€210**"],
        ["Kinderen onder 12 jaar: **gratis**", "Enfants de moins de 12 ans : **gratuit**", "Children under 12: **free**"],
        ["Pakket 3 nachten: **€1260** · 5 nachten: **€1860** · 10 nachten: **€3240**", "Forfait 3 nuits : **1260 €** · 5 nuits : **1860 €** · 10 nuits : **3240 €**", "Package of 3 nights: **€1260** · 5 nights: **€1860** · 10 nights: **€3240**"],
      ],
      p: [["Nachtsessies zijn beperkt tot 8 personen.", "Les séances de nuit sont limitées à 8 personnes.", "Night sessions are limited to 8 people."]],
    },
  ]),
  book(i, c, "book", L_NIGHT, { kind: "book_night" }),
  { id: c.id("availability"), type: "availability_preview", kind: "night", days: 14 },
];

const MEMBERSHIP: Builder = (i, c) => [
  imageText(i, c, "text", "community", "left", [
    { h: ["BEAM Membership: **€396 per jaar**", "BEAM Membership : **396 € par an**", "BEAM Membership: **€396 a year**"], p: [["Voor wie regelmatig komt opladen. Je krijgt een genummerde fysieke ledenkaart en:", "Pour ceux qui viennent se ressourcer régulièrement. Vous recevez une carte de membre numérotée et :", "For those who come to recharge regularly. You get a numbered physical member card and:"]], list: [
      ["Eén gratis nachtsessie of vier dagsessies (waarde €420)", "Une séance de nuit offerte ou quatre séances de jour (valeur 420 €)", "One free night session or four day sessions (worth €420)"],
      ["Tot **20% korting** op sessies en pakketten", "Jusqu'à **20 % de réduction** sur les séances et forfaits", "Up to **20% off** sessions and packages"],
      ["15% korting op producten en events", "15 % de réduction sur les produits et événements", "15% off products and events"],
      ["30% korting op detoxzout", "30 % de réduction sur le sel détox", "30% off detox salt"],
      ["Twee bijeenkomsten per jaar enkel voor leden", "Deux rencontres par an réservées aux membres", "Two members-only gatherings a year"],
      ["Maandelijkse trekking van een gratis nachtsessie", "Tirage mensuel d'une séance de nuit offerte", "A monthly draw for a free night session"],
    ] },
  ]),
  ...[priceCards(i, c, "price", ["Lidmaatschap", "Adhésion", "Membership"], [BEAM_SKUS.membershipYear])].filter((b): b is Block => !!b),
  cta(i, c, "cta", ["Word lid van BEAM", "Devenez membre de BEAM", "Become a BEAM member"], ["Je lidmaatschap beheer je in je account, samen met je boekingen en pakketten.", "Vous gérez votre adhésion dans votre compte, avec vos réservations et forfaits.", "You manage your membership in your account, together with your bookings and packages."], ["Lid worden", "Devenir membre", "Join now"], portal("membership")),
];

const PRICING: Builder = (i, c) => {
  const single = priceCards(i, c, "single", L_SINGLE, [BEAM_SKUS.dayAdult, BEAM_SKUS.dayYouth, BEAM_SKUS.nightAdult, BEAM_SKUS.nightYouth]);
  const hoursCards = priceCards(i, c, "hours", L_HOURS, [BEAM_SKUS.hours10, BEAM_SKUS.hours20, BEAM_SKUS.hours30, BEAM_SKUS.hours50, BEAM_SKUS.hours100]);
  const nightCards = priceCards(i, c, "nights", L_NIGHTS, [BEAM_SKUS.nights3, BEAM_SKUS.nights5, BEAM_SKUS.nights10]);
  const member = priceCards(i, c, "membership", ["Membership", "Membership", "Membership"], [BEAM_SKUS.membershipYear]);
  if (single && hoursCards && nightCards && member) {
    return [
      rt(i, c, "intro", [{ p: [["Alle prijzen zijn inclusief btw. Pakketten deel je met maximaal **vijf personen** en blijven **18 maanden** geldig. Kinderen onder 12 jaar komen gratis mee.", "Tous les prix TVA comprise. Les forfaits se partagent avec **cinq personnes** maximum et restent valables **18 mois**. Les enfants de moins de 12 ans viennent gratuitement.", "All prices include VAT. Packages can be shared by up to **five people** and stay valid for **18 months**. Children under 12 come free."]] }]),
      single,
      hoursCards,
      nightCards,
      member,
      book(i, c, "book-day", L_DAY, { kind: "book_day" }),
      book(i, c, "book-night", L_NIGHT, { kind: "book_night" }),
      book(i, c, "gift", L_GIFT, { kind: "gift" }),
    ];
  }
  return PRICING_TEXT(i, c);
};

const PRICING_TEXT: Builder = (i, c) => [
  rt(i, c, "text", [
    { p: [["Alle prijzen zijn inclusief btw. Het basistarief is **€60 per uur**; een sessie duurt 2 uur. Pakketten kunnen met maximaal **vijf personen** gedeeld worden en blijven **18 maanden** geldig.", "Tous les prix s'entendent TVA comprise. Le tarif de base est de **60 € de l'heure** ; une séance dure 2 heures. Les forfaits se partagent avec **cinq personnes** maximum et restent valables **18 mois**.", "All prices include VAT. The base rate is **€60 an hour**; a session lasts 2 hours. Packages can be shared by up to **five people** and stay valid for **18 months**."]] },
    { h: ["Urenpakketten (dagsessies)", "Forfaits d'heures (séances de jour)", "Hour packages (day sessions)"], list: [
      ["10 uur (5 sessies): **€495** · €49,50 per uur", "10 heures (5 séances) : **495 €** · 49,50 € de l'heure", "10 hours (5 sessions): **€495** · €49.50 an hour"],
      ["20 uur: **€890** · €44,50 per uur (populair)", "20 heures : **890 €** · 44,50 € de l'heure (populaire)", "20 hours: **€890** · €44.50 an hour (popular)"],
      ["30 uur: **€1260** · €42 per uur", "30 heures : **1260 €** · 42 € de l'heure", "30 hours: **€1260** · €42 an hour"],
      ["50 uur: **€1850** · €37 per uur", "50 heures : **1850 €** · 37 € de l'heure", "50 hours: **€1850** · €37 an hour"],
      ["100 uur: **€3300** · €33 per uur", "100 heures : **3300 €** · 33 € de l'heure", "100 hours: **€3300** · €33 an hour"],
    ] },
    { h: ["Nachtpakketten", "Forfaits de nuits", "Night packages"], list: [
      ["3 nachten: **€1260** · €35 per uur", "3 nuits : **1260 €** · 35 € de l'heure", "3 nights: **€1260** · €35 an hour"],
      ["5 nachten: **€1860** · €31 per uur (populair)", "5 nuits : **1860 €** · 31 € de l'heure (populaire)", "5 nights: **€1860** · €31 an hour (popular)"],
      ["10 nachten: **€3240** · €27 per uur", "10 nuits : **3240 €** · 27 € de l'heure", "10 nights: **€3240** · €27 an hour"],
    ] },
    { h: ["Losse sessies", "Séances à l'unité", "Single sessions"], list: [
      ["Dagsessie volwassene: **€120** · jongere 12-18: **€60** · kind onder 12: gratis", "Séance de jour adulte : **120 €** · jeune 12-18 : **60 €** · enfant de moins de 12 ans : gratuit", "Day session adult: **€120** · young person 12-18: **€60** · child under 12: free"],
      ["Nachtsessie volwassene: **€420** · jongere 12-18: **€210** · kind onder 12: gratis", "Séance de nuit adulte : **420 €** · jeune 12-18 : **210 €** · enfant de moins de 12 ans : gratuit", "Night session adult: **€420** · young person 12-18: **€210** · child under 12: free"],
    ] },
  ]),
  book(i, c, "book-day", L_DAY, { kind: "book_day" }),
  book(i, c, "book-night", L_NIGHT, { kind: "book_night" }),
  book(i, c, "gift", L_GIFT, { kind: "gift" }),
];

const ABOUT: Builder = (i, c) => [
  rt(i, c, "text", [
    { h: ["Wanneer energie verandert, **verandert alles**", "Quand l'énergie change, **tout change**", "When energy changes, **everything changes**"], p: [
      ["Het moderne leven vraagt constant aandacht, belast ons zenuwstelsel en put onze mentale capaciteit uit. Ondanks ongeziene investeringen in welzijn blijven burn-out en stressgerelateerd verzuim toenemen. Het probleem is niet een gebrek aan inspanning: de meeste benaderingen pakken energie niet aan **op het niveau waar het werkelijk speelt**.", "La vie moderne exige une attention constante, sollicite notre système nerveux et épuise nos capacités mentales. Malgré des investissements sans précédent dans le bien-être, le burn-out et l'absentéisme lié au stress continuent d'augmenter. Le problème n'est pas un manque d'effort : la plupart des approches ne traitent pas l'énergie **là où elle se joue vraiment**.", "Modern life demands constant attention, strains our nervous system and drains our mental capacity. Despite unprecedented investment in wellbeing, burnout and stress-related absence keep rising. The problem is not a lack of effort: most approaches don't address energy **at the level where it really plays out**."],
    ] },
    { h: ["BEAM keert terug naar de basis: **energie zelf**", "BEAM revient à l'essentiel : **l'énergie elle-même**", "BEAM returns to the basis: **energy itself**"], p: [
      ["Wij creëren ruimtes die coherentie, regulatie en herstel bevorderen, zodat lichaam en zenuwstelsel kunnen doen waartoe ze van nature in staat zijn. Wanneer de regulatie zich stabiliseert, volgt herstel vanzelf. En vanuit herstel keert de capaciteit terug.", "Nous créons des espaces qui favorisent la cohérence, la régulation et la récupération, pour que le corps et le système nerveux puissent faire ce dont ils sont naturellement capables. Quand la régulation se stabilise, la récupération suit. Et avec elle, la capacité revient.", "We create spaces that support coherence, regulation and recovery, so the body and nervous system can do what they are naturally capable of. When regulation stabilises, recovery follows. And from recovery, capacity returns."],
    ], list: [
      ["BEAM is geen wellness-extraatje.", "BEAM n'est pas un supplément bien-être.", "BEAM is not a wellness extra."],
      ["BEAM is geen productiviteitstool.", "BEAM n'est pas un outil de productivité.", "BEAM is not a productivity tool."],
      ["BEAM is geen therapie of coaching.", "BEAM n'est ni une thérapie ni du coaching.", "BEAM is not therapy or coaching."],
    ] },
  ]),
  imageText(i, c, "founders", "founders", "left", [
    { h: ["De **oprichters**", "Les **fondateurs**", "The **founders**"], list: [
      ["**Jonathan Bossaer**: oprichter van BRANDEPIC, verantwoordelijk voor strategie, investeerders- en zakelijke relaties en merkidentiteit.", "**Jonathan Bossaer** : fondateur de BRANDEPIC, responsable de la stratégie, des relations avec les investisseurs et partenaires et de l'identité de marque.", "**Jonathan Bossaer**: founder of BRANDEPIC, responsible for strategy, investor and business relations, and brand identity."],
      ["**Sanne de Regt**: gastprogramma's, contact met de community en de verfijning van de ervaring.", "**Sanne de Regt** : programmes pour les hôtes, lien avec la communauté et raffinement de l'expérience.", "**Sanne de Regt**: guest programmes, community contact and refining the experience."],
      ["**Christophe Haddad**: ontwerp en realisatie van de BEAM-omgeving, met een achtergrond in operations en mensgericht ontwerp.", "**Christophe Haddad** : conception et réalisation de l'environnement BEAM, avec une expérience en opérations et en design centré sur l'humain.", "**Christophe Haddad**: design and build of the BEAM environment, with a background in operations and human-centred design."],
    ] },
  ]),
  cta(i, c, "cta", ["Ervaar het zelf", "Faites-en l'expérience", "Experience it yourself"], ["De beste manier om BEAM te begrijpen is er te zijn.", "La meilleure façon de comprendre BEAM, c'est d'y être.", "The best way to understand BEAM is to be there."], BOOK, portal("book_day")),
];

const ENVIRONMENT: Builder = (i, c) => [
  imageText(i, c, "text", "beds", "right", [
    { h: ["Menselijke systemen herstellen wanneer **de omgeving** het toelaat", "Les systèmes humains récupèrent quand **l'environnement** le permet", "Human systems recover when **the environment** allows it"], p: [
      ["Het lichaam reageert voortdurend op de omstandigheden waarin het zich bevindt. Wanneer die stabiel, coherent en rustig zijn, kan het zenuwstelsel efficiënter reguleren. Daardoor wordt herstel mogelijk, en vanuit herstel ontstaat opnieuw vitaliteit.", "Le corps réagit en permanence aux conditions dans lesquelles il se trouve. Quand elles sont stables, cohérentes et calmes, le système nerveux se régule plus efficacement. La récupération devient possible, et avec elle la vitalité.", "The body constantly responds to the conditions it is in. When they are stable, coherent and calm, the nervous system regulates more efficiently. That makes recovery possible, and from recovery vitality returns."],
      ["Licht reguleert het circadiane ritme. Geluid beïnvloedt de hersenactiviteit. Temperatuur en zintuiglijke prikkels beïnvloeden stress en herstel. Onderzoek naar natuurlijke omgevingen toont een meetbare afname van stressmarkers en een verbeterde hartslagvariabiliteit.", "La lumière règle le rythme circadien. Le son influence l'activité cérébrale. La température et les stimuli sensoriels influencent le stress et la récupération. Les recherches sur les environnements naturels montrent une baisse mesurable des marqueurs de stress et une meilleure variabilité cardiaque.", "Light regulates the circadian rhythm. Sound shapes brain activity. Temperature and sensory input affect stress and recovery. Research on natural environments shows a measurable drop in stress markers and improved heart rate variability."],
    ] },
    { h: ["**Coherentie** is de basis", "La **cohérence** est la base", "**Coherence** is the foundation"], p: [["Bij BEAM richten we ons op de omgeving, niet op het individu. Elke ontwerpkeuze, van licht en materialen tot rust en geluid, is erop gericht dat het lichaam geen verstoringen hoeft te compenseren.", "Chez BEAM, nous agissons sur l'environnement, pas sur l'individu. Chaque choix de conception, de la lumière aux matériaux, du calme au son, vise à ce que le corps n'ait plus à compenser de perturbations.", "At BEAM we focus on the environment, not the individual. Every design choice, from light and materials to quiet and sound, aims to spare the body from compensating for disturbances."]] },
  ]),
  cta(i, c, "cta", ["Ontdek de technologie", "Découvrez la technologie", "Discover the technology"], ["48 gesynchroniseerde EESystem-units, geïntegreerd in de ruimte.", "48 unités EESystem synchronisées, intégrées à l'espace.", "48 synchronised EESystem units, built into the space."], ["Meer over de technologie", "En savoir plus", "More about the technology"], c.page("technology")),
];

const TECHNOLOGY: Builder = (i, c) => [
  imageText(i, c, "text", "cell", "right", [
    { h: ["Een systeem **geïntegreerd in de ruimte**", "Un système **intégré à l'espace**", "A system **built into the space**"], p: [["Het Energy Enhancement System™ is een niet-invasieve technologie die in de BEAM-omgeving is geïntegreerd. Niet om in te grijpen op het lichaam, maar om bij te dragen aan de stabiliteit en coherentie van de ruimte waarin het lichaam zich bevindt.", "L'Energy Enhancement System™ est une technologie non invasive intégrée à l'environnement BEAM. Non pas pour agir sur le corps, mais pour contribuer à la stabilité et à la cohérence de l'espace où il se trouve.", "The Energy Enhancement System™ is a non-invasive technology built into the BEAM environment. Not to act on the body, but to contribute to the stability and coherence of the space the body is in."]] },
    { h: ["**48 gesynchroniseerde units**", "**48 unités synchronisées**", "**48 synchronised units**"], p: [["De BEAM-installatie behoort tot de grootste coherente EESystem-omgevingen in Europa. Elke unit is zo gepositioneerd en gekalibreerd dat de signalen als één coherent geheel samenwerken. Grotere systemen zorgen voor meer ruimtelijke symmetrie, een gelijkmatiger signaalverdeling en een stabiele omgeving, waar je ook zit.", "L'installation BEAM compte parmi les plus grands environnements EESystem cohérents d'Europe. Chaque unité est positionnée et calibrée pour que les signaux fonctionnent comme un tout cohérent. Un système plus grand offre plus de symétrie, une répartition plus homogène et un environnement stable, où que vous soyez.", "The BEAM installation is among the largest coherent EESystem environments in Europe. Each unit is positioned and calibrated so the signals work together as one coherent whole. Larger systems give more spatial symmetry, a more even signal spread and a stable environment wherever you sit."]] },
    { h: ["Wetenschappelijke context", "Contexte scientifique", "Scientific context"], p: [["De concepten achter het EESystem worden onderzocht binnen systeembiologie, bio-elektriciteit en cellulaire regulatie, neurowetenschap en stressfysiologie, en fotobiomodulatie. Het EESystem is **geen behandeling** en vervangt geen medische zorg: het maakt deel uit van een omgevingsarchitectuur waarin het lichaam zichzelf kan reguleren.", "Les concepts derrière l'EESystem sont étudiés en biologie des systèmes, bioélectricité et régulation cellulaire, neurosciences et physiologie du stress, et photobiomodulation. L'EESystem **n'est pas un traitement** et ne remplace pas les soins médicaux : il fait partie d'une architecture environnementale où le corps peut se réguler.", "The concepts behind the EESystem are studied in systems biology, bioelectricity and cellular regulation, neuroscience and stress physiology, and photobiomodulation. The EESystem is **not a treatment** and does not replace medical care: it is part of an environmental architecture in which the body can regulate itself."]] },
  ]),
  faq(i, c, "faq", ["Vragen over de technologie", "Questions sur la technologie", "Questions about the technology"], FAQ_TECH),
];

const EXPERIENCES: Builder = (i, c) => [
  rt(i, c, "intro", [{ p: [["Mensen beschrijven hun ervaring op verschillende manieren: diepere ontspanning, betere slaap, meer helderheid en focus, een stabieler energieniveau. **145 vijfsterrenrecensies** op Google.", "Chacun décrit son expérience à sa manière : une détente plus profonde, un meilleur sommeil, plus de clarté et de concentration, une énergie plus stable. **145 avis cinq étoiles** sur Google.", "People describe their experience in different ways: deeper relaxation, better sleep, more clarity and focus, more stable energy. **145 five-star reviews** on Google."]] }]),
  ...reviews(i, c, "review"),
  cta(i, c, "cta", ["Voel het zelf", "Ressentez-le vous-même", "Feel it for yourself"], ["Boek je eerste sessie van 2 uur.", "Réservez votre première séance de 2 heures.", "Book your first 2-hour session."], BOOK, portal("book_day")),
];

const CORPORATE: Builder = (i, c) => [
  imageText(i, c, "text", "corporate", "right", [{ h: ["Menselijke energie is **even essentieel** als kapitaal, talent of strategie", "L'énergie humaine est **aussi essentielle** que le capital, le talent ou la stratégie", "Human energy is **as essential** as capital, talent or strategy"], p: [["BEAM werkt met organisaties die beseffen dat duurzame prestaties energie vereisen in plaats van extra druk. Voor privé-sessies, incentives of groepservaringen op maat bekijken we samen wat het best aansluit.", "BEAM travaille avec des organisations qui savent que la performance durable demande de l'énergie plutôt que davantage de pression. Pour des séances privées, des incentives ou des expériences de groupe sur mesure, nous cherchons ensemble la meilleure formule.", "BEAM works with organisations that understand sustainable performance needs energy rather than more pressure. For private sessions, incentives or tailored group experiences, we look together at what fits best."]] }]),
  cards(i, c, "formats", ["Formules voor teams", "Formules pour les équipes", "Formats for teams"], [
    { h: ["BEAM Discovery Experience", "BEAM Discovery Experience", "BEAM Discovery Experience"], t: ["Een eerste kennismaking voor je team met de BEAM-ruimte en wat energie voor je organisatie betekent.", "Une première découverte de l'espace BEAM pour votre équipe et de ce que l'énergie signifie pour votre organisation.", "A first introduction for your team to the BEAM space and what energy means for your organisation."] },
    { h: ["Corporate Reset Day", "Corporate Reset Day", "Corporate Reset Day"], t: ["Vijf uur in de BEAM-ruimte met lezingen van Marina Riemslagh en Jonathan Bossaer, een workshop, ontbijt en lunch.", "Cinq heures dans l'espace BEAM avec des conférences de Marina Riemslagh et Jonathan Bossaer, un atelier, petit-déjeuner et déjeuner.", "Five hours in the BEAM space with talks by Marina Riemslagh and Jonathan Bossaer, a workshop, breakfast and lunch."] },
    { h: ["BEAM Corporate Venue", "BEAM Corporate Venue", "BEAM Corporate Venue"], t: ["Exclusieve huur voor teamdagen, offsites, keynotes en HR-events, met projectie en geluidsinstallatie.", "Location exclusive pour journées d'équipe, offsites, keynotes et événements RH, avec projection et sonorisation.", "Exclusive hire for team days, offsites, keynotes and HR events, with projection and sound."] },
  ], "list"),
  cta(i, c, "cta", ["Plan een kennismakingsgesprek", "Planifiez un appel de découverte", "Book an intro call"], ["Prijzen op aanvraag. We bespreken graag wat je team nodig heeft.", "Prix sur demande. Parlons de ce dont votre équipe a besoin.", "Prices on request. We'd love to discuss what your team needs."], ["Vraag een gesprek aan", "Demander un appel", "Request a call"], { kind: "url", href: "https://calendly.com/brandepicbv/beam-intro-call" }),
];

const FAQ_PAGE: Builder = (i, c) => [
  faq(i, c, "sessions", ["BEAM & sessies", "BEAM & séances", "BEAM & sessions"], FAQ_SESSIONS),
  faq(i, c, "practical", ["Praktische informatie", "Informations pratiques", "Practical information"], FAQ_PRACTICAL),
  faq(i, c, "tech", ["De technologie", "La technologie", "The technology"], FAQ_TECH),
  cta(i, c, "cta", ["Niet gevonden wat je zocht?", "Vous n'avez pas trouvé ?", "Didn't find what you were looking for?"], ["Neem gerust contact op, we helpen je graag verder.", "Contactez-nous, nous vous aidons volontiers.", "Get in touch, we're happy to help."], ["Contact", "Contact", "Contact"], c.page("contact")),
];

const CONTACT: Builder = (i, c) => [
  imageText(i, c, "text", "location", "right", [
    { p: [["We antwoorden binnen 48 uur. Je vindt ons in het Latem Business Park, eerste verdieping: vanuit Gent het tweede blok, helemaal achteraan. Neem de lift en bel aan bij \"BEAM Vitality Center\".", "Nous répondons sous 48 heures. Vous nous trouvez au Latem Business Park, premier étage : en venant de Gand, le deuxième bloc, tout au fond. Prenez l'ascenseur et sonnez chez « BEAM Vitality Center ».", "We reply within 48 hours. You'll find us in the Latem Business Park, first floor: coming from Ghent, the second block at the very back. Take the lift and ring \"BEAM Vitality Center\"."]] },
    { list: [
      ["Xavier de Cocklaan 70, bus 7, 9831 Sint-Martens-Latem", "Xavier de Cocklaan 70, boîte 7, 9831 Sint-Martens-Latem", "Xavier de Cocklaan 70, box 7, 9831 Sint-Martens-Latem, Belgium"],
      ["welcome@beam.be", "welcome@beam.be", "welcome@beam.be"],
      ["+32 9 39 12 422 (9 tot 19 uur) · WhatsApp +32 469 41 31 11", "+32 9 39 12 422 (9 h à 19 h) · WhatsApp +32 469 41 31 11", "+32 9 39 12 422 (9:00 to 19:00) · WhatsApp +32 469 41 31 11"],
    ] },
  ]),
  { id: c.id("form"), type: "form_embed", formSlug: "contact" },
  { id: c.id("contact"), type: "contact_details", showAddress: false, showPhone: false, showEmail: false, showOpeningHours: true },
];

export const SITE_SEED_PAGES: readonly SeedPage[] = [
  { slug: "home", kind: "home", title: ["BEAM Vitality Center", "BEAM Vitality Center", "BEAM Vitality Center"], path: ["", "", ""], description: ["BEAM Vitality Center bij Gent: Europa's grootste 48-unit EESystem-installatie in Sint-Martens-Latem. Dagsessies, nachtsessies en pakketten.", "BEAM Vitality Center près de Gand : la plus grande installation EESystem de 48 unités d'Europe à Sint-Martens-Latem. Séances de jour, de nuit et forfaits.", "BEAM Vitality Center near Ghent: Europe's largest 48-unit EESystem installation in Sint-Martens-Latem. Day sessions, night sessions and packages."], sections: [], build: HOME },
  { slug: "about", kind: "standard", title: ["Over BEAM", "À propos de BEAM", "About BEAM"], path: ["beam", "beam", "beam"], description: desc(["Wie we zijn en waarom we BEAM bouwden", "Qui nous sommes et pourquoi BEAM", "Who we are and why we built BEAM"]), sections: [], build: ABOUT },
  { slug: "environment", kind: "standard", title: ["De BEAM-omgeving", "L'environnement BEAM", "The BEAM environment"], path: ["omgeving", "environnement", "environment"], description: desc(["Een ruimte ontworpen voor herstel", "Un espace conçu pour la récupération", "A space designed for recovery"]), sections: [], build: ENVIRONMENT },
  { slug: "technology", kind: "standard", title: ["De technologie", "La technologie", "The technology"], path: ["technologie", "technologie", "technology"], description: desc(["Het Energy Enhancement System met 48 units", "L'Energy Enhancement System de 48 unités", "The 48-unit Energy Enhancement System"]), sections: [], build: TECHNOLOGY },
  { slug: "day-sessions", kind: "offer", title: ["Dagsessies", "Séances de jour", "Day sessions"], path: ["sessies", "seances", "sessions"], description: desc(["Dagsessies van 2 uur", "Des séances de jour de 2 heures", "2-hour day sessions"]), sections: [], build: DAY_SESSIONS },
  { slug: "nights", kind: "offer", title: ["Nachtsessies", "Séances de nuit", "Night sessions"], path: ["nachtsessies", "seances-de-nuit", "night-sessions"], description: desc(["Nachtsessies van 12 uur", "Des séances de nuit de 12 heures", "12-hour night sessions"]), sections: [], build: NIGHTS },
  { slug: "memberships", kind: "offer", title: ["Membership", "Membership", "Membership"], path: ["membership", "membership", "membership"], description: desc(["Het BEAM-lidmaatschap", "L'adhésion BEAM", "The BEAM membership"]), sections: [], build: MEMBERSHIP },
  { slug: "pricing", kind: "pricing", title: ["Pakketten & prijzen", "Forfaits & tarifs", "Packages & prices"], path: ["prijzen", "tarifs", "prices"], description: desc(["Alle prijzen en pakketten", "Tous les tarifs et forfaits", "All prices and packages"]), sections: [], build: PRICING },
  { slug: "experiences", kind: "standard", title: ["Ervaringen", "Témoignages", "Experiences"], path: ["ervaringen", "temoignages", "experiences"], description: desc(["Wat gasten over BEAM zeggen", "Ce que disent nos hôtes", "What guests say about BEAM"]), sections: [], build: EXPERIENCES },
  { slug: "corporate", kind: "standard", title: ["Voor bedrijven", "Pour les entreprises", "For organisations"], path: ["bedrijven", "entreprises", "corporates"], description: desc(["BEAM voor teams en organisaties", "BEAM pour les équipes et organisations", "BEAM for teams and organisations"]), sections: [], build: CORPORATE },
  { slug: "faq", kind: "standard", title: ["Veelgestelde vragen", "Questions fréquentes", "Frequently asked questions"], path: ["faq", "faq", "faq"], description: desc(["Antwoorden op je vragen", "Les réponses à vos questions", "Answers to your questions"]), sections: [], build: FAQ_PAGE },
  { slug: "events", kind: "events_index", title: ["Events", "Événements", "Events"], path: ["evenementen", "evenements", "events"], description: desc(["Concerten, lezingen en webinars", "Concerts, conférences et webinaires", "Concerts, talks and webinars"]), sections: [], extra: "events" },
  { slug: "blog", kind: "blog_index", title: ["Blog", "Blog", "Blog"], path: ["blog", "blog", "blog"], description: desc(["Nieuws en inzichten", "Actualités et réflexions", "News and insights"]), sections: [], extra: "posts" },
  { slug: "contact", kind: "contact", title: ["Contact", "Contact", "Contact"], path: ["contact", "contact", "contact"], description: desc(["Contact, adres en openingsuren", "Contact, adresse et horaires", "Contact, address and opening hours"]), sections: [], build: CONTACT },
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

/** The blocks of a seeded page in one locale; `pageLink` resolves another seeded page by slug, `product` a catalogue SKU. */
function blocksOf(
  page: SeedPage,
  i: number,
  pageLink: (slug: string) => Link,
  product: (sku: string) => string | undefined = () => undefined,
  media: (key: MediaKey) => string | undefined = () => undefined,
): Block[] {
  const id = (part: string) => seedUuid(`${page.slug}:${i}:${part}`);
  if (page.build) return page.build(i, { id, page: pageLink, product, media });
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

/** Header sub-items per top-level slug (depth 2): five items on top, the rest in dropdowns. */
const HEADER_CHILDREN: Record<string, { slug: string; label?: L3 }[]> = {
  about: [{ slug: "about", label: ["Ons verhaal", "Notre histoire", "Our story"] }, { slug: "environment" }, { slug: "technology" }, { slug: "experiences" }],
  "day-sessions": [{ slug: "day-sessions" }, { slug: "nights" }, { slug: "pricing" }, { slug: "memberships" }],
};
/** Shorter top-level labels than the page titles. */
const HEADER_LABELS: Record<string, L3> = {
  about: ["Over BEAM", "À propos", "About"],
  "day-sessions": ["Sessies", "Séances", "Sessions"],
  corporate: ["Bedrijven", "Entreprises", "Organisations"],
};

const MENUS: { key: "header" | "footer" | "legal"; slugs: string[] }[] = [
  { key: "header", slugs: ["about", "day-sessions", "events", "corporate", "contact"] },
  { key: "footer", slugs: ["nights", "memberships", "pricing", "faq", "blog", "corporate"] },
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

  // Pass 1: the page rows, so pass 2 can link pages to each other by id.
  const fresh: { page: SeedPage; id: string }[] = [];
  for (const page of SITE_SEED_PAGES) {
    const [row] = await db
      .insert(pages)
      .values({ kind: page.kind, slug: page.slug, legalKey: page.legalKey ?? null, status: "draft" })
      .onConflictDoNothing()
      .returning({ id: pages.id });
    if (row) fresh.push({ page, id: row.id });
  }
  const pageIds = new Map((await db.select({ id: pages.id, slug: pages.slug }).from(pages)).map((p) => [p.slug, p.id]));
  const pageLink = (slug: string): Link => {
    const pageId = pageIds.get(slug);
    if (!pageId) throw new Error(`site seed: unknown page slug ${slug}`);
    return { kind: "page", pageId };
  };
  const product = await catalogueLookup(db);
  const media = fresh.length ? await seedSiteMedia(db) : () => undefined;

  // Pass 2: a published version 1 and live routes for every page this run created.
  const created: string[] = [];
  for (const { page, id } of fresh) {
    const row = { id };
    const seo = per<PageSeo>((i) => ({ title: page.title[i]!.slice(0, 70), description: page.description[i]!, ...(page.noindex ? { noindex: true } : {}) }));
    const [version] = await db
      .insert(pageVersions)
      .values({
        pageId: row.id,
        version: 1,
        state: "published",
        title: txt(page.title),
        paths: txt(page.path),
        blocks: per((i) => blocksOf(page, i, pageLink, product, media)),
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

  const ids = pageIds;
  for (const menu of MENUS) {
    const items: NavItem[] = menu.slugs
      .filter((s) => ids.has(s))
      .map((s) => {
        const p = SITE_SEED_PAGES.find((x) => x.slug === s)!;
        const isHeader = menu.key === "header";
        const children = isHeader
          ? (HEADER_CHILDREN[s] ?? [])
              .filter((ch) => ids.has(ch.slug))
              .map((ch) => ({
                id: seedUuid(`menu:header:${s}:${ch.slug}`),
                label: txt(ch.label ?? SITE_SEED_PAGES.find((x) => x.slug === ch.slug)!.title),
                target: { kind: "page" as const, pageId: ids.get(ch.slug)! },
              }))
          : [];
        return {
          id: seedUuid(`menu:${menu.key}:${s}`),
          label: txt((isHeader && HEADER_LABELS[s]) || p.title),
          target: { kind: "page", pageId: ids.get(s)! },
          ...(children.length ? { children } : {}),
        };
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

/** Active catalogue products by SKU (empty before commerce's demo catalogue ran). */
async function catalogueLookup(db: DbOrTx): Promise<(sku: string) => string | undefined> {
  const rows = await db.select({ id: products.id, sku: products.sku, isActive: products.isActive }).from(products);
  const bySku = new Map(rows.filter((r) => r.isActive).map((r) => [r.sku, r.id]));
  return (sku) => bySku.get(sku);
}

/** Versions written by this seed (anything else was edited by staff and is never replaced). */
const SEED_SUMMARIES = new Set(["Seed placeholder content", "Seed: catalogue prices"]);

/** JSON with sorted object keys: jsonb reorders keys, so plain `JSON.stringify` never matches a stored value. */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) : v,
  );
}

/**
 * Seeded pages whose builder shows catalogue prices (`pricing_table`) once the demo catalogue
 * exists: when the live version is still a seed version and the rebuilt blocks differ, it publishes
 * the next version with them (routes follow). Pages staff edited are left alone. Idempotent.
 */
export async function refreshSeededCataloguePages(db: DbOrTx, now: Date): Promise<string[]> {
  const product = await catalogueLookup(db);
  const media = await seedSiteMedia(db);
  const pageIds = new Map((await db.select({ id: pages.id, slug: pages.slug }).from(pages)).map((p) => [p.slug, p.id]));
  const pageLink = (slug: string): Link => ({ kind: "page", pageId: pageIds.get(slug)! });
  const refreshed: string[] = [];
  for (const page of SITE_SEED_PAGES) {
    const pageId = pageIds.get(page.slug);
    if (!page.build || !pageId) continue;
    const [live] = await db
      .select({ id: pageVersions.id, version: pageVersions.version, blocks: pageVersions.blocks, title: pageVersions.title, paths: pageVersions.paths, seo: pageVersions.seo, changeSummary: pageVersions.changeSummary })
      .from(pageVersions)
      .innerJoin(pages, eq(pages.currentVersionId, pageVersions.id))
      .where(eq(pages.id, pageId));
    if (!live || !SEED_SUMMARIES.has(live.changeSummary ?? "")) continue;
    const blocks = per((i) => blocksOf(page, i, pageLink, product, media));
    if (stableJson(blocks) === stableJson(live.blocks)) continue;
    const [version] = await db
      .insert(pageVersions)
      .values({ pageId, version: live.version + 1, state: "published", title: live.title, paths: live.paths, blocks, seo: live.seo, locales: [...LOCALES], createdBy: "user", changeSummary: "Seed: catalogue prices", basedOnVersionId: live.id, publishedAt: now })
      .onConflictDoNothing()
      .returning({ id: pageVersions.id });
    if (!version) continue;
    await db.update(pages).set({ currentVersionId: version.id, updatedAt: now }).where(eq(pages.id, pageId));
    await db.update(pageRoutes).set({ versionId: version.id }).where(eq(pageRoutes.pageId, pageId));
    refreshed.push(page.slug);
  }
  return refreshed;
}

/** The demo blog post (`demo` profile helper, called by `apps/web/modules/site/seed.ts`). */
export const DEMO_POST_SLUG = "welcome-to-beam";

/**
 * The `demo` profile: the placeholder content (if the defaults did not run) plus one published
 * blog post, so the blog index, RSS feed and posts list show something. Idempotent on the slug.
 */
export async function seedSiteDemo(db: DbOrTx, opts: { now?: Date } = {}): Promise<{ postCreated: boolean }> {
  const now = opts.now ?? new Date();
  await seedSiteContent(db, { now });
  await refreshSeededCataloguePages(db, now);
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

/**
 * Every text of a seeded page in one locale (block strings, rich-text runs), with stand-in ids for
 * links, products and photos. For tests that compare a page with its source text.
 */
export function seedPageStrings(slug: string, i: number): string[] {
  const page = SITE_SEED_PAGES.find((p) => p.slug === slug);
  if (!page) throw new Error(`site seed: unknown page slug ${slug}`);
  const stub = seedUuid("stub");
  const STRUCTURAL = new Set(["id", "type", "marks", "attrs"]);
  const out: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) if (!STRUCTURAL.has(k)) walk(x); // marks and node types sit between the words of one sentence
  };
  walk(blocksOf(page, i, () => ({ kind: "page", pageId: stub }), () => stub, () => stub));
  return out;
}
