/**
 * Building blocks of the site seed pages (`site.ts` and `site-pages/*.ts`): the locale triple
 * `L3` (nl-BE, fr-BE, en), rich-text parts with `**bold**` spans, and one helper per block
 * presentation (hero, chapter, statement band, icon cards, photo cards, image beside text,
 * portrait video, booking tiles, reviews, FAQ, CTA). Photos come from `assets/beam/` through
 * `SITE_MEDIA` plus each page module's own `media`.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { imageSize, type Block, type Link, type PageKind, type RichBlockNode, type RichDoc, type RichTextNode } from "@beam/core/site";
import type { DbOrTx } from "../client";
import { files } from "../schema/platform";
import { mediaAssets } from "../schema/site";
import type { Locale, LocalizedText } from "../schema/_shared";

export type L3 = [nl: string, fr: string, en: string];
export const LOCALES: readonly Locale[] = ["nl-BE", "fr-BE", "en"];
export const per = <T>(f: (i: number, l: Locale) => T): Record<Locale, T> => ({ "nl-BE": f(0, "nl-BE"), "fr-BE": f(1, "fr-BE"), en: f(2, "en") });
export const txt = (v: L3): LocalizedText => per((i) => v[i]!);

/** What a page builder gets: stable block ids, links to other seeded pages, catalogue product ids by SKU and media ids by key. */
export type BuildCtx = { id: (part: string) => string; page: (slug: string) => Link; product: (sku: string) => string | undefined; media: (key: MediaKey) => string | undefined };

// ---------------------------------------------------------------------------
// Media: photos of beam.be (packages/db/src/seed/assets/beam/), public images in the media library.
// ---------------------------------------------------------------------------

/** A photo for the media library: a file in `assets/beam/` and its alt text per locale. */
export type MediaSeed = { file: string; alt: L3 };

export const SITE_MEDIA = {
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
} satisfies Record<string, MediaSeed>;
/** A media key: one of `SITE_MEDIA` or of a page module's `media`. */
export type MediaKey = string;

/** Stores the seed photos as public image files and media assets (once: matched by sha256); returns media ids by key. */
export async function seedSiteMedia(db: DbOrTx, media: Record<string, MediaSeed> = SITE_MEDIA): Promise<(key: MediaKey) => string | undefined> {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "assets", "beam");
  const out = new Map<MediaKey, string>();
  for (const [key, m] of Object.entries(media)) {
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
export function priceCards(i: number, c: BuildCtx, key: string, heading: L3, skus: string[]): Block | null {
  const ids = skus.map((s) => c.product(s));
  if (ids.some((x) => !x)) return null;
  return { id: c.id(key), type: "pricing_table", heading: heading[i]!, productIds: ids as string[], showMemberPrice: false };
}
export type Builder = (i: number, c: BuildCtx) => Block[];

/** Inline text with `**bold**` spans. */
export function inline(s: string): RichTextNode[] {
  return s
    .split(/(\*\*[^*]+\*\*)/)
    .filter(Boolean)
    .map((part) => (part.startsWith("**") ? { type: "text" as const, text: part.slice(2, -2), marks: [{ type: "bold" as const }] } : { type: "text" as const, text: part }));
}

/** A rich-text part: an optional `h2` (or `h3`), paragraphs and a bullet list. */
export type Part = { h?: L3; h3?: L3; p?: L3[]; list?: L3[] };

export function doc(i: number, parts: Part[]): RichDoc {
  const content: RichBlockNode[] = [];
  for (const part of parts) {
    if (part.h) content.push({ type: "heading", attrs: { level: 2 }, content: inline(part.h[i]!) });
    if (part.h3) content.push({ type: "heading", attrs: { level: 3 }, content: inline(part.h3[i]!) });
    for (const p of part.p ?? []) content.push({ type: "paragraph", content: inline(p[i]!) });
    if (part.list?.length) content.push({ type: "bulletList", content: part.list.map((li) => ({ type: "listItem", content: [{ type: "paragraph", content: inline(li[i]!) }] })) });
  }
  return { type: "doc", content };
}

export const rt = (i: number, c: BuildCtx, key: string, parts: Part[]): Block => ({ id: c.id(key), type: "rich_text", doc: doc(i, parts) });
export const portal = (route: "book" | "book_day" | "book_night" | "home" | "membership" | "packages" | "bookings"): Link => ({ kind: "portal", route });
export const hero = (i: number, c: BuildCtx, heading: L3, sub: L3, cta?: { label: L3; link: Link }, img?: MediaKey): Block => {
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
export type CardSeed = { h: L3; t: L3; link?: Link; img?: MediaKey };
export const cards = (i: number, c: BuildCtx, key: string, heading: L3 | null, list: CardSeed[], layout?: "cards" | "list" | "split"): Block => ({
  id: c.id(key),
  type: "card_grid",
  ...(heading ? { heading: heading[i]! } : {}),
  ...(layout ? { layout } : {}),
  cards: list.map((x) => {
    const mediaId = x.img ? c.media(x.img) : undefined;
    return { heading: x.h[i]!, text: x.t[i]!, ...(mediaId ? { mediaId } : {}), ...(x.link ? { link: x.link } : {}) };
  }),
});
export const book = (i: number, c: BuildCtx, key: string, label: L3, target: { kind: "book_day" } | { kind: "book_night" } | { kind: "gift" }, note?: L3): Block => ({
  id: c.id(key),
  type: "booking_cta",
  label: label[i]!,
  ...(note ? { note: note[i]! } : {}),
  target,
});
/** Text beside a photo; plain rich text when the photo is not in the media library. */
export const imageText = (i: number, c: BuildCtx, key: string, img: MediaKey, side: "left" | "right", parts: Part[]): Block => {
  const mediaId = c.media(img);
  return mediaId ? { id: c.id(key), type: "image_text", mediaId, imageSide: side, doc: doc(i, parts) } : rt(i, c, key, parts);
};
export const cta = (i: number, c: BuildCtx, key: string, heading: L3, body: L3, label: L3, link: Link): Block => ({ id: c.id(key), type: "cta", heading: heading[i]!, text: body[i]!, button: { label: label[i]!, link } });
export const faq = (i: number, c: BuildCtx, key: string, heading: L3, items: { q: L3; a: L3[] }[]): Block => ({
  id: c.id(key),
  type: "faq",
  heading: heading[i]!,
  items: items.map((x) => ({ question: x.q[i]!, answer: doc(i, [{ p: x.a }]) })),
});
/**
 * Real Google reviews of BEAM (5 stars, captured from beam.be's Trustindex widget on 2026-11-15),
 * quoted verbatim in their own language on every locale. BEAM confirms consent before go-live (rule 21).
 */
export const GOOGLE_REVIEWS: { q: string; a: string; date: L3 }[] = [
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
export const reviews = (i: number, c: BuildCtx, key: string, count = GOOGLE_REVIEWS.length): Block[] =>
  GOOGLE_REVIEWS.slice(0, count).map((r, n) => ({ id: c.id(`${key}-${n}`), type: "testimonial", quote: r.q, authorName: r.a, authorDetail: r.date[i]!, consentConfirmed: true }));

export const BOOK: L3 = ["Boek je sessie", "Réservez votre séance", "Book your session"];
export const L_DAY: L3 = ["Dagsessie boeken", "Réserver une séance de jour", "Book a day session"];
export const L_NIGHT: L3 = ["Nachtsessie boeken", "Réserver une séance de nuit", "Book a night session"];
export const L_GIFT: L3 = ["Cadeaubon geven", "Offrir un bon cadeau", "Give a gift voucher"];

export const SCHEDULE: Part = {
  h: ["Dagsessies", "Séances de jour", "Day sessions"],
  p: [["Elke dag drie sessies van **2 uur**, behalve op dinsdag en woensdag:", "Chaque jour trois séances de **2 heures**, sauf le mardi et le mercredi :", "Three **2-hour** sessions every day, except Tuesday and Wednesday:"]],
  list: [
    ["Van 10 tot 12 uur", "De 10 h à 12 h", "10:00 to 12:00"],
    ["Van 13 tot 15 uur (zaterdag: kindersessie)", "De 13 h à 15 h (samedi : séance enfants)", "13:00 to 15:00 (Saturday: children's session)"],
    ["Van 16 tot 18 uur (maandag: huisdieren welkom)", "De 16 h à 18 h (lundi : animaux bienvenus)", "16:00 to 18:00 (Monday: pets welcome)"],
  ],
};

export const FAQ_SESSIONS = [
  { q: ["Hoe lang duurt een sessie?", "Combien de temps dure une séance ?", "How long does a session last?"] as L3, a: [["Een standaardsessie duurt 2 uur. Nachtsessies duren 12 uur, van 20 tot 8 uur.", "Une séance standard dure 2 heures. Les séances de nuit durent 12 heures, de 20 h à 8 h.", "A standard session lasts 2 hours. Night sessions last 12 hours, from 20:00 to 08:00."] as L3] },
  { q: ["Hoeveel mensen zijn er aanwezig?", "Combien de personnes sont présentes ?", "How many people take part?"] as L3, a: [["Aan dagsessies nemen tot 14 personen deel. Nachtsessies zijn beperkt tot 8 personen voor het comfort.", "Jusqu'à 14 personnes participent aux séances de jour. Les séances de nuit sont limitées à 8 personnes pour le confort.", "Up to 14 people join a day session. Night sessions are limited to 8 people for comfort."] as L3] },
  { q: ["Dag- of nachtsessie?", "Séance de jour ou de nuit ?", "Day or night session?"] as L3, a: [["Beide gebruiken dezelfde ruimte. Dagsessies zijn toegankelijker voor een eerste bezoek; 's nachts blijf je langer ononderbroken in de ruimte terwijl je lichaam rust.", "Les deux utilisent le même espace. Les séances de jour sont plus accessibles pour une première visite ; la nuit, vous restez plus longtemps sans interruption pendant que votre corps se repose.", "Both use the same space. Day sessions are easier for a first visit; at night you stay longer without interruption while your body rests."] as L3] },
  { q: ["Mag ik mijn pakket delen?", "Puis-je partager mon forfait ?", "Can I share my package?"] as L3, a: [["Ja, pakketten kunnen met maximaal vijf personen worden gedeeld en blijven 18 maanden geldig.", "Oui, les forfaits se partagent avec cinq personnes maximum et restent valables 18 mois.", "Yes, packages can be shared by up to five people and stay valid for 18 months."] as L3] },
];

export const FAQ_PRACTICAL = [
  { q: ["Welke kledij raden jullie aan?", "Quelle tenue recommandez-vous ?", "What should I wear?"] as L3, a: [["Comfortabele kleding. Het doel is dat je lichaam volledig kan ontspannen.", "Des vêtements confortables. Le but est que votre corps puisse se détendre complètement.", "Comfortable clothing. The aim is to let your body relax completely."] as L3] },
  { q: ["Hoe bereid ik me voor?", "Comment me préparer ?", "How do I prepare?"] as L3, a: [["Kom indien mogelijk uitgerust aan en drink voldoende water. Een specifieke voorbereiding is niet nodig.", "Arrivez reposé si possible et buvez suffisamment d'eau. Aucune préparation particulière n'est nécessaire.", "Arrive rested if you can and drink enough water. No specific preparation is needed."] as L3] },
  { q: ["Wat doe ik na een sessie?", "Que faire après une séance ?", "What do I do after a session?"] as L3, a: [["Neem tijd voor rust en herstel en denk aan een zoutbad. Voldoende drinken en een rustig tempo ondersteunen je ervaring.", "Prenez le temps de vous reposer et pensez à un bain de sel. Boire suffisamment et garder un rythme calme prolongent l'expérience.", "Take time to rest and consider a salt bath. Drinking enough water and keeping a calm pace support the experience."] as L3] },
  { q: ["Mag ik mijn kind of huisdier meenemen?", "Puis-je venir avec mon enfant ou mon animal ?", "Can I bring my child or pet?"] as L3, a: [["Kinderen zijn welkom op zaterdag van 13 tot 15 uur, huisdieren op maandag van 16 tot 18 uur. Laat het ons vooraf weten.", "Les enfants sont les bienvenus le samedi de 13 h à 15 h, les animaux le lundi de 16 h à 18 h. Prévenez-nous à l'avance.", "Children are welcome on Saturdays from 13:00 to 15:00, pets on Mondays from 16:00 to 18:00. Please let us know in advance."] as L3] },
  { q: ["Is er parking en is de ruimte toegankelijk?", "Y a-t-il un parking et l'espace est-il accessible ?", "Is there parking and is the space accessible?"] as L3, a: [["Er zijn enkele parkeerplaatsen op het terrein en gratis openbare parkeerplaatsen vlakbij. De ruimte is rolstoelvriendelijk; neem vooraf contact op.", "Quelques places de parking sur le site et un parking public gratuit à proximité. L'espace est accessible en fauteuil roulant ; contactez-nous à l'avance.", "There are a few parking spaces on site and free public parking nearby. The space is wheelchair friendly; please contact us in advance."] as L3] },
];

export const FAQ_TECH = [
  { q: ["Wat is het Energy Enhancement System™?", "Qu'est-ce que l'Energy Enhancement System™ ?", "What is the Energy Enhancement System™?"] as L3, a: [["Een niet-invasieve technologie die in de BEAM-ruimte is geïntegreerd en bijdraagt aan stabiele, coherente omgevingscondities.", "Une technologie non invasive intégrée à l'espace BEAM qui contribue à des conditions ambiantes stables et cohérentes.", "A non-invasive technology built into the BEAM space that contributes to stable, coherent environmental conditions."] as L3] },
  { q: ["Hoeveel units staan er bij BEAM?", "Combien d'unités compte BEAM ?", "How many units does BEAM have?"] as L3, a: [["48 gesynchroniseerde units: een van de grootste coherente EESystem-omgevingen in Europa.", "48 unités synchronisées : l'un des plus grands environnements EESystem cohérents d'Europe.", "48 synchronised units: one of the largest coherent EESystem environments in Europe."] as L3] },
  { q: ["Is dit een vervanging voor medische zorg?", "Est-ce un substitut aux soins médicaux ?", "Does this replace medical care?"] as L3, a: [["Nee. BEAM stelt geen diagnoses, behandelt niet en vervangt geen medische zorg.", "Non. BEAM ne pose pas de diagnostic, ne traite pas et ne remplace pas les soins médicaux.", "No. BEAM does not diagnose, treat or replace medical care."] as L3] },
  { q: ["Moet ik erin geloven?", "Faut-il y croire ?", "Do I have to believe in it?"] as L3, a: [["Nee, de omgeving functioneert onafhankelijk van persoonlijke overtuigingen.", "Non, l'environnement fonctionne indépendamment des convictions personnelles.", "No, the environment works regardless of personal beliefs."] as L3] },
];

export const DAY_NOTE: L3 = ["2 uur · €120", "2 heures · 120 €", "2 hours · €120"];
export const NIGHT_NOTE: L3 = ["12 uur · €420", "12 heures · 420 €", "12 hours · €420"];
export const GIFT_NOTE: L3 = ["Vanaf €25 · 2 jaar geldig", "Dès 25 € · valable 2 ans", "From €25 · valid 2 years"];

/** Story text: the heading stands beside the text; long text continues behind "read more". */
export const chapter = (i: number, c: BuildCtx, key: string, parts: Part[]): Block => ({ id: c.id(key), type: "rich_text", variant: "chapter", doc: doc(i, parts) });
/** One or two big lines on a navy band with the gold wave. */
export const statement = (i: number, c: BuildCtx, key: string, lines: L3[]): Block => ({ id: c.id(key), type: "rich_text", variant: "statement", doc: doc(i, [{ p: lines }]) });
/** A vertical video (YouTube Short) beside its text; a story chapter when the poster photo is not in the media library. */
export const videoStory = (i: number, c: BuildCtx, key: string, youtubeId: string, title: L3, poster: MediaKey, parts: Part[]): Block => {
  const posterMediaId = c.media(poster);
  return posterMediaId ? { id: c.id(key), type: "video", youtubeId, title: title[i]!, posterMediaId, portrait: true, doc: doc(i, parts) } : chapter(i, c, key, parts);
};
export type CardIcon = NonNullable<Extract<Block, { type: "card_grid" }>["cards"][number]["icon"]>;
/** Cards with a gold brand icon of beam.be. */
export const iconCards = (i: number, c: BuildCtx, key: string, heading: L3 | null, list: { h: L3; t: L3; icon: CardIcon; link?: Link }[]): Block => ({
  id: c.id(key),
  type: "card_grid",
  layout: "icons",
  ...(heading ? { heading: heading[i]! } : {}),
  cards: list.map((x) => ({ heading: x.h[i]!, text: x.t[i]!, icon: x.icon, ...(x.link ? { link: x.link } : {}) })),
});


/** Title, path and description of a seeded page per locale (nl-BE, fr-BE, en); a page module exports one for a page it adds. */
export type PageMeta = { slug: string; kind: PageKind; title: L3; path: L3; description: L3 };

/** What a page module in `site-pages/` exports. */
export type PageModule = { build: Builder; media?: Record<string, MediaSeed>; meta?: PageMeta };
