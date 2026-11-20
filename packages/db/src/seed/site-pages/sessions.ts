/**
 * Site pages of the "sessions" group: day sessions (the old beam.be /sessies/ page), nights,
 * packages & prices and the membership. They tell the whole text of beam.be's /sessies/ and
 * /membership/ (nl and en verbatim, fr translated; `sessions.coverage.test.ts` fails when a line goes
 * missing). With the catalogue seeded, prices come live from it (`pricing_table`) and the price
 * lists only add what the old price tables said around the amount (price per hour, saving); without
 * it, the same pages show the amounts in those lists. The story text is the same in both.
 */
import type { Block } from "@beam/core/site";
import { BEAM_SKUS } from "../commerce";
import {
  BOOK, DAY_NOTE, FAQ_SESSIONS, L_DAY, L_GIFT, L_NIGHT, NIGHT_NOTE,
  book, cards, chapter, cta, faq, hero, imageText, portal, priceCards, statement,
  type BuildCtx, type Builder, type L3, type MediaKey, type MediaSeed, type PageModule,
} from "../site-kit";

/** One text per locale from a function of the locale index. */
const l3 = (f: (n: 0 | 1 | 2) => string): L3 => [f(0), f(1), f(2)];
const joined = (...parts: L3[]): L3 => l3((n) => parts.map((p) => p[n]).join(" "));

const MEDIA = {
  "sessions-lounge": {
    file: "2-2.webp",
    alt: [
      "Gasten praten na hun sessie bij een kopje thee in de zetels van BEAM",
      "Des hôtes discutent autour d'une tasse de thé dans les canapés de BEAM après leur séance",
      "Guests chatting over a cup of tea on the BEAM sofas after their session",
    ],
  },
  "sessions-circle": {
    file: "Banner-background-1600x400-1.webp",
    alt: [
      "Een grote groep zit in een kring tijdens een meditatie bij BEAM",
      "Un grand groupe assis en cercle lors d'une méditation chez BEAM",
      "A large group sitting in a circle during a meditation at BEAM",
    ],
  },
} satisfies Record<string, MediaSeed>;

/** A full-width photo; nothing when it is not in the media library. */
const photo = (c: BuildCtx, key: string, img: MediaKey): Block[] => {
  const mediaId = c.media(img);
  return mediaId ? [{ id: c.id(key), type: "image", mediaId }] : [];
};

// ---------------------------------------------------------------------------
// The price lists: one line per price table of beam.be.
// ---------------------------------------------------------------------------

/** A price table of beam.be: its name, the catalogue amount (text only without the catalogue) and its lines. */
type Rate = { name: L3; price?: L3; parts: L3[] };

const eur = (n: number): L3 => [`€${n}`, `${n} €`, `€${n}`];
const perHour = (nl: string, en = nl): L3 => [`€${nl} per uur in plaats van €60`, `${nl} € de l'heure au lieu de 60 €`, `€${en} per hour instead of €60`];
const save = (n: number): L3 => [`bespaar €${n}`, `économie de ${n} €`, `save €${n}`];
const FREE: L3 = ["**gratis**", "**gratuit**", "**free**"];
const POPULAR: L3 = ["populair", "populaire", "popular"];
const WITH_ADULT: L3 = ["met volwassene", "avec un adulte", "with adult"];

const nightPack = (n: number, price: number, hour: number, saving: number, popular = false): Rate => ({
  name: [`Pakket van ${n} nachtsessies`, `Forfait de ${n} séances de nuit`, `Package of ${n} night sessions`],
  price: eur(price),
  parts: [...(popular ? [POPULAR] : []), perHour(String(hour)), save(saving)],
});
const hourPack = (h: number, price: number, hour: [string, string], saving: number, popular = false): Rate => ({
  name: [`${h} uren pakket`, `Forfait ${h} heures`, `${h} hour package`],
  price: eur(price),
  parts: [...(popular ? [POPULAR] : []), [`${h / 2} dagsessies van 2 uur`, `${h / 2} séances de jour de 2 heures`, `${h / 2} two-hour day sessions`], perHour(...hour), save(saving)],
});

const NIGHT_RATES: Rate[] = [
  nightPack(3, 1260, 35, 900),
  nightPack(5, 1860, 31, 1740, true),
  nightPack(10, 3240, 27, 3960),
  { name: ["Nachtsessie (Volwassenen)", "Séance de nuit (adultes)", "Night sessions (Adults)"], price: eur(420), parts: [["Sessie volwassenen (enkele matras)", "Séance adulte (matelas individuel)", "Adult session (single mattress)"], perHour("35"), save(300)] },
  { name: ["Nachtsessie (Kinderen 12 - 18)", "Séance de nuit (jeunes de 12 à 18 ans)", "Night sessions (Kids 12 - 18)"], price: eur(210), parts: [["Sessie jongeren (enkele matras)", "Séance jeunes (matelas individuel)", "Teen session (single mattress)"], perHour("17,50", "17.50"), save(510)] },
  { name: ["Nachtsessie (Kinderen onder 12)", "Séance de nuit (enfants de moins de 12 ans)", "Night sessions (Kids under 12)"], parts: [FREE, ["Sessie kinderen (enkele matras)", "Séance enfants (matelas individuel)", "Kids session (single mattress)"], perHour("0"), save(720)] },
];

const HOUR_RATES: Rate[] = [
  hourPack(10, 495, ["49,50", "49.50"], 105),
  hourPack(20, 890, ["44,50", "44.50"], 310, true),
  hourPack(30, 1260, ["42", "42"], 540),
  hourPack(50, 1850, ["37", "37"], 1150),
  hourPack(100, 3300, ["33", "33"], 2700),
];

const DAY_RATES: Rate[] = [
  { name: ["2 uur dagsessie (Volwassenen)", "Séance de jour de 2 heures (adultes)", "2-hour daytime session (Adults)"], price: eur(120), parts: [["standaardprijs", "prix standard", "standard price"], ["Sessie voor volwassenen", "Séance pour adultes", "Session for adults"], ["€60 per uur", "60 € de l'heure", "€60 per hour"]] },
  { name: ["2 uur dagsessie (Jongeren 12 - 18)", "Séance de jour de 2 heures (jeunes de 12 à 18 ans)", "2-hour day session (Kids ages 12–18)"], price: eur(60), parts: [WITH_ADULT, perHour("30"), save(60)] },
  { name: ["2 uur dagsessie (Kinderen onder 12)", "Séance de jour de 2 heures (enfants de moins de 12 ans)", "2-hour session (Kids under 12)"], parts: [FREE, WITH_ADULT, perHour("0"), save(120)] },
];
const PET_RATE: Rate = { name: ["Huisdieren (maandag van 16 tot 18 uur)", "Animaux de compagnie (lundi de 16 h à 18 h)", "Pets (Monday from 4pm to 6pm)"], parts: [["€20 per huisdier", "20 € par animal", "€20 per pet"]] };

/** A price list beside its heading; `live` leaves out the amounts the catalogue's price cards show. */
const rates = (i: number, c: BuildCtx, key: string, heading: L3, list: Rate[], live: boolean): Block =>
  chapter(i, c, key, [{
    h: heading,
    list: list.map((r) => l3((n) => `**${r.name[n]}**${n === 1 ? " : " : ": "}${[...(r.price && !live ? [`**${r.price[n]}**`] : []), ...r.parts.map((p) => p[n])].join(" · ")}`)),
  }]);

// ---------------------------------------------------------------------------
// Texts shared by the pages.
// ---------------------------------------------------------------------------

const NIGHT_WHEN: L3 = [
  "De nachtsessies (12 uren) vinden plaats van woensdag tot zondag van 20 uur tot 8 uur.",
  "Les séances de nuit (12 heures) ont lieu du mercredi au dimanche, de 20 h à 8 h.",
  "Overnight sessions (12 hours) are available from Wednesday to Sunday, from 8pm to 8am.",
];
const NIGHT_REST: L3 = [
  "Tijdens de nachtsessies kun je uitgebreid en ononderbroken genieten van de BEAM-ruimte, terwijl je lichaam vanzelf tot diepe rust komt.",
  "Pendant les séances de nuit, vous profitez longuement et sans interruption de l'espace BEAM, tandis que votre corps trouve de lui-même un repos profond.",
  "Overnight sessions offer an extended and uninterrupted experience of the BEAM environment while the body is naturally in its deepest state of restoration.",
];
const NIGHT_BED: L3 = [
  "Je hebt een eigen bed ter beschikking in de BEAM-ruimte, terwijl de omgeving de hele nacht stabiel en coherent blijft.",
  "Vous disposez de votre propre lit dans l'espace BEAM, tandis que l'environnement reste stable et cohérent toute la nuit.",
  "You rest in a private bed within the BEAM environment while the space supports stable and coherent conditions throughout the night.",
];
/** Why nights, after Dr. Sandra Rose Michael (one bullet of the rates on beam.be). */
const NIGHT_WHY: L3[] = [
  [
    "Hoewel we begrijpen dat **nachtsessies** misschien niet de eerste keuze zijn voor nieuwkomers, willen we de unieke voordelen ervan benadrukken.",
    "Nous comprenons que les **séances de nuit** ne soient pas forcément le premier choix des nouveaux venus, mais nous tenons à en souligner les avantages uniques.",
    "Although we understand that **night sessions** may not be the first choice for newcomers, we want to highlight their unique benefits.",
  ],
  [
    "Volgens uitvinder Dr. Sandra Rose Michael zijn nachtsessies het meest effectief omwille van hun **diep therapeutische werking**, waarbij wordt ingespeeld op alfa-, theta- en deltagolven. We moedigen onze gasten daarom aan om de transformerende kracht van onze nachtsessies te verkennen.",
    "Selon le Dr Sandra Rose Michael, l'inventrice du système, les séances de nuit sont les plus efficaces en raison de leur **effet profondément thérapeutique**, qui fait intervenir les ondes alpha, thêta et delta. Nous encourageons donc nos hôtes à découvrir le pouvoir transformateur de nos séances de nuit.",
    "According to inventor Dr. Sandra Rose Michael, night sessions are the most effective due to their **deeply therapeutic effect**, as they engage alpha, theta, and delta brainwave states. We therefore encourage our guests to explore the transformative power of our night sessions.",
  ],
  [
    "We bieden onze overnachtingen ook aan tegen zeer scherpe prijzen omdat ze een cruciale rol spelen bij herstel en vitaliteit.",
    "Nous proposons aussi nos nuitées à des prix très avantageux, car elles jouent un rôle essentiel dans la récupération et la vitalité.",
    "We also offer our overnight stays at very competitive rates, as they play a crucial role in recovery and vitality.",
  ],
];

const L_DAY_SINGLE: L3 = ["Losse dagsessies", "Séances de jour à l'unité", "Single day sessions"];
const L_NIGHT_SINGLE: L3 = ["Losse nachtsessies", "Séances de nuit à l'unité", "Single night sessions"];
const L_HOURS: L3 = ["Urenpakketten", "Forfaits d'heures", "Hour packages"];
const L_NIGHT_PACKS: L3 = ["Nachtpakketten", "Forfaits de nuits", "Night packages"];

const pricingCta = (i: number, c: BuildCtx): Block =>
  cta(
    i,
    c,
    "cta-pricing",
    ["Pakketten & prijzen", "Forfaits & tarifs", "Packages & pricing"],
    ["Alle tarieven van dag- en nachtsessies, pakketten en het BEAM membership.", "Tous les tarifs des séances de jour et de nuit, des forfaits et du BEAM membership.", "All rates for day and night sessions, packages and the BEAM membership."],
    ["Bekijk de prijzen", "Voir les tarifs", "View prices"],
    c.page("pricing"),
  );

/** The week of beam.be's opening-hours table. */
const OPENING: L3[] = [
  ["**Maandag**: 10u – 12u · 13u – 15u · 16u – 18u (huisdieren welkom) · 's nachts gesloten", "**Lundi** : 10 h – 12 h · 13 h – 15 h · 16 h – 18 h (animaux bienvenus) · fermé la nuit", "**Monday**: 10 – 12h · 13 – 15h · 16 – 18h (pets welcome) · closed at night"],
  ["**Dinsdag**: gesloten", "**Mardi** : fermé", "**Tuesday**: closed"],
  ["**Woensdag**: overdag gesloten · 20u – 8u", "**Mercredi** : fermé en journée · 20 h – 8 h", "**Wednesday**: closed during the day · 20 – 8h"],
  ["**Donderdag**: 10u – 12u · 13u – 15u · 16u – 18u · 20u – 8u", "**Jeudi** : 10 h – 12 h · 13 h – 15 h · 16 h – 18 h · 20 h – 8 h", "**Thursday**: 10 – 12h · 13 – 15h · 16 – 18h · 20 – 8h"],
  ["**Vrijdag**: 10u – 12u · 13u – 15u · 16u – 18u · 20u – 8u", "**Vendredi** : 10 h – 12 h · 13 h – 15 h · 16 h – 18 h · 20 h – 8 h", "**Friday**: 10 – 12h · 13 – 15h · 16 – 18h · 20 – 8h"],
  ["**Zaterdag**: 10u – 12u · 13u – 15u (kinderen welkom) · 16u – 18u · 20u – 8u", "**Samedi** : 10 h – 12 h · 13 h – 15 h (enfants bienvenus) · 16 h – 18 h · 20 h – 8 h", "**Saturday**: 10 – 12h · 13 – 15h (children welcome) · 16 – 18h · 20 – 8h"],
  ["**Zondag**: 10u – 12u · 13u – 15u · 16u – 18u · 20u – 8u", "**Dimanche** : 10 h – 12 h · 13 h – 15 h · 16 h – 18 h · 20 h – 8 h", "**Sunday**: 10 – 12h · 13 – 15h · 16 – 18h · 20 – 8h"],
];

// ---------------------------------------------------------------------------
// Day sessions: the old /sessies/ page (path "sessies").
// ---------------------------------------------------------------------------

const DAY_SESSIONS: Builder = (i, c) => {
  const single = priceCards(i, c, "prices", L_DAY_SINGLE, [BEAM_SKUS.dayAdult, BEAM_SKUS.dayYouth]);
  const packs = priceCards(i, c, "packages", L_HOURS, [BEAM_SKUS.hours10, BEAM_SKUS.hours20, BEAM_SKUS.hours30]);
  const live = single && packs ? [single, packs] : null;
  return [
    hero(i, c, ["EESystem Sessies bij BEAM Vitality Center", "Séances EESystem chez BEAM Vitality Center", "EESystem Sessions at BEAM Vitality Center"], [
      "Een ruimte ontworpen voor herstel en duurzame vitaliteit.",
      "Un espace conçu pour la récupération et une vitalité durable.",
      "A space designed for restoration and sustained vitality.",
    ], { label: BOOK, link: portal("book_day") }, "hero"),
    book(i, c, "quick-day", L_DAY, { kind: "book_day" }, DAY_NOTE),
    book(i, c, "quick-night", L_NIGHT, { kind: "book_night" }, NIGHT_NOTE),
    statement(i, c, "statement-intro", [[
      "BEAM biedt sessies aan in een **rustgevende en coherente omgeving**, waardoor het lichaam en het zenuwstelsel zich vanzelf kunnen herstellen en in balans kunnen komen.",
      "BEAM propose des séances dans un **environnement apaisant et cohérent**, où le corps et le système nerveux peuvent d'eux-mêmes récupérer et retrouver leur équilibre.",
      "BEAM offers structured sessions within a **calm and coherent environment**, allowing the body and nervous system to regulate and recover naturally.",
    ]]),
    imageText(i, c, "day", "day", "right", [{
      h: ["**Dagsessies**", "**Séances de jour**", "**Day sessions**"],
      p: [[
        "We bieden dagelijks (behalve op dinsdag en woensdag) drie sessies aan van telkens **2 uur**, tussen 10 en 18 uur:",
        "Nous proposons chaque jour (sauf le mardi et le mercredi) trois séances de **2 heures**, entre 10 h et 18 h :",
        "We offer three **2-hour** sessions every day (except Tuesdays and Wednesdays) between 10 am and 6 pm:",
      ]],
      list: [
        ["Van 10 tot 12 uur", "De 10 h à 12 h", "From 10am to 12pm"],
        ["Van 13 tot 15 uur", "De 13 h à 15 h", "From 1pm to 3pm"],
        ["Van 16 tot 18 uur", "De 16 h à 18 h", "From 4pm to 6pm"],
      ],
    }, {
      p: [
        ["Kinderen zijn welkom op zaterdag van 13 tot 15 uur.", "Les enfants sont les bienvenus le samedi de 13 h à 15 h.", "Children are welcome on Saturday from 1pm to 3pm."],
        ["Huisdieren zijn welkom op maandag van 16 tot 18 uur.", "Les animaux de compagnie sont les bienvenus le lundi de 16 h à 18 h.", "Pets may join on Monday from 4pm to 6pm."],
      ],
    }]),
    { id: c.id("availability"), type: "availability_preview", kind: "day", days: 7 },
    cards(i, c, "formats", [
      "Je kan kiezen uit dag- of nachtsessies of langere formules, afhankelijk van je behoeften en beschikbaarheid.",
      "Séances de jour, de nuit ou formules plus longues : à vous de choisir selon vos besoins et vos disponibilités.",
      "You can choose between day sessions, night sessions or longer formats depending on your needs and availability.",
    ], [
      { h: ["Nachtsessies", "Séances de nuit", "Night sessions"], t: joined(NIGHT_WHEN, NIGHT_REST, NIGHT_BED), link: c.page("nights"), img: "night" },
      {
        h: ["Pakketten", "Forfaits", "Packages"],
        t: [
          "Voor wie vaker gebruik wil maken van onze diensten, bieden we pakketten aan van 10 tot 100 uur tegen voordelige tarieven. Klik hier om de voordeelpakketten te bekijken. Pakketten kunnen met maximaal vijf personen worden gedeeld en blijven 18 maanden geldig.",
          "Pour celles et ceux qui souhaitent venir plus souvent, nous proposons des forfaits de 10 à 100 heures à des tarifs avantageux. Cliquez ici pour découvrir les forfaits à tarif réduit. Les forfaits peuvent être partagés avec cinq personnes maximum et restent valables 18 mois.",
          "For those who want to engage more consistently, we offer packages ranging from 10 to 100 hours at preferred rates. Click here to view the discounted packages. Packages can be shared with up to five people and remain valid for 18 months.",
        ],
        link: c.page("pricing"),
        img: "relax",
      },
      {
        h: ["Voor particulieren en bedrijven", "Pour les particuliers et les entreprises", "Private & corporate experiences"],
        t: [
          "Neem gerust contact met ons op voor privésessies, groepsreservaties of bedrijfsactiviteiten. We bekijken graag samen wat het beste aansluit bij jouw wensen.",
          "N'hésitez pas à nous contacter pour des séances privées, des réservations de groupe ou des activités d'entreprise. Nous verrons volontiers ensemble ce qui correspond le mieux à vos souhaits.",
          "For private sessions, group bookings or corporate experiences, feel free to contact us. We are happy to explore what best fits your needs.",
        ],
        link: c.page("contact"),
        img: "sessions-lounge",
      },
    ]),
    chapter(i, c, "hours", [{
      h: ["**Openingsuren**", "**Heures d'ouverture**", "**Opening hours**"],
      p: [[
        "Als je vier uur bij BEAM wilt doorbrengen, raden we je aan om twee opeenvolgende sessies van 2 uur te reserveren. **Het uur ertussen krijg je van ons cadeau**. Als je bijvoorbeeld van 10 tot 12 uur en van 13 tot 15 uur reserveert, kan je vijf uur lang ononderbroken genieten.",
        "Si vous souhaitez passer quatre heures chez BEAM, nous vous conseillons de réserver deux séances consécutives de 2 heures. **L'heure entre les deux vous est offerte**. Si vous réservez par exemple de 10 h à 12 h et de 13 h à 15 h, vous profitez de cinq heures sans interruption.",
        "For those who wish to spend four hours at BEAM, we invite you to book two consecutive 2-hour sessions. The hour between them is our **gift to you**. For example, booking from 10am to 12pm and from 1pm to 3pm gives you a continuous five-hour experience.",
      ]],
      list: OPENING,
    }]),
    rates(i, c, "rates", ["**Prijzen** dagsessies", "**Tarifs** des séances de jour", "Day session **prices**"], DAY_RATES, !!live),
    ...(live ?? []),
    book(i, c, "book", L_DAY, { kind: "book_day" }),
    chapter(i, c, "kids", [{
      h: ["Kinderen en jongeren", "Enfants et jeunes", "Children and teens"],
      p: [
        ["Kinderen zijn van harte welkom in BEAM.", "Les enfants sont les bienvenus chez BEAM.", "Children are very welcome at BEAM."],
        [
          "**Kinderen onder de 12 jaar** kunnen **gratis** een sessie bijwonen onder begeleiding van minstens één ouder. Jongeren tussen de 12 en 18 jaar krijgen 50% korting op individuele dag- en nachtsessies.",
          "Les **enfants de moins de 12 ans** peuvent assister **gratuitement** à une séance, accompagnés d'au moins un parent. Les jeunes de 12 à 18 ans bénéficient de 50 % de réduction sur les séances individuelles de jour et de nuit.",
          "**Children under the age of 12** can attend a session **free of charge**, provided they are accompanied by at least one parent. Children aged between 12 and 18 receive a 50% discount on individual day and night sessions.",
        ],
        [
          "Om een optimale ervaring te kunnen garanderen voor alle aanwezigen, hebben we ervoor gekozen om kindermomenten in te plannen. Op **zaterdagen** zijn kinderen welkom voor de sessie **van 13 tot 15 uur**. Om alles soepel te laten verlopen, vragen we je vriendelijk om het ons vooraf te laten weten.",
          "Afin de garantir une expérience optimale à toutes les personnes présentes, nous avons choisi de prévoir des moments réservés aux enfants. Le **samedi**, les enfants sont les bienvenus pour la séance **de 13 h à 15 h**. Pour que tout se passe au mieux, nous vous demandons de nous prévenir à l'avance.",
          "To ensure the best possible experience for everyone attending, we have decided to schedule specific times for children. On **Saturdays**, children are welcome for the session **from 1 pm to 3 pm**. To ensure everything runs smoothly, we kindly ask you to let us know in advance.",
        ],
      ],
    }]),
    chapter(i, c, "pets", [{
      h: ["Huisdieren", "Animaux de compagnie", "Pets"],
      p: [
        [
          "**Huisdieren** zijn welkom op **maandagen** voor de sessie **van 16 tot 18 uur** en worden toegelaten aan een tarief van €20 per huisdier.",
          "Les **animaux de compagnie** sont les bienvenus le **lundi** pour la séance **de 16 h à 18 h**, au tarif de 20 € par animal.",
          "Pets are welcome on **Mondays** during the session from **4 pm to 6 pm** and are admitted at a rate of €20 per pet.",
        ],
        [
          "We verzoeken vriendelijk om je huisdier tijdens de sessie in een mand of kooi te houden. Het is niet toegestaan om dieren vrij te laten rondlopen in de ruimte.",
          "Nous vous demandons de garder votre animal dans un panier ou une cage pendant la séance. Les animaux ne peuvent pas circuler librement dans la salle.",
          "We kindly ask that you keep your pet in a basket or cage during the session. Pets are not permitted to roam freely around the room.",
        ],
      ],
    }]),
    cards(i, c, "most", ["Hoe haal je het meeste uit je sessie?", "Comment tirer le meilleur parti de votre séance ?", "How to get the most out of your session"], [
      {
        h: ["Voorafgaand aan je sessie", "Avant votre séance", "Before your session"],
        t: [
          "Kom indien mogelijk uitgerust aan. Voldoende vocht innemen ondersteunt de natuurlijke regulatieprocessen van je lichaam.",
          "Arrivez reposé si possible. Bien vous hydrater soutient les processus naturels de régulation de votre corps.",
          "Arrive in a rested state where possible. Staying well hydrated supports your body’s natural regulatory processes.",
        ],
      },
      {
        h: ["Tijdens je sessie", "Pendant votre séance", "During your session"],
        t: [
          "De sessies zijn bedoeld om het zenuwstelsel tot rust te laten komen zodat het zichzelf kan reguleren. Je kan lekker rustig zitten of in de comfortabele relax-zetels liggen. Er is geen techniek of actieve inspanning nodig.",
          "Les séances permettent au système nerveux de s'apaiser pour qu'il puisse se réguler lui-même. Vous pouvez vous asseoir tranquillement ou vous allonger dans les fauteuils de relaxation confortables. Aucune technique ni aucun effort actif n'est nécessaire.",
          "Sessions are designed to allow the nervous system to settle and regulate. You can simply rest, sit or lie down comfortably. No technique or active effort is required.",
        ],
      },
      {
        h: ["Na je sessie", "Après votre séance", "After your session"],
        t: [
          "Geef je lichaam de tijd om alles te integreren en te herstellen. Voldoende drinken, lichte en voedzame maaltijden en wat tijd vrijmaken om te rusten, kan je proces ondersteunen. Hoe vaker je in de BEAM-omgeving vertoeft, hoe groter de positieve effecten op langere termijn. Het is dus beter om regelmatig te komen.",
          "Laissez à votre corps le temps de tout intégrer et de récupérer. Boire suffisamment, prendre des repas légers et nourrissants et vous réserver du temps pour vous reposer peut soutenir ce processus. Plus vous séjournez souvent dans l'environnement BEAM, plus les effets positifs à long terme sont importants. Mieux vaut donc venir régulièrement.",
          "Give your body time to integrate and recover. Staying hydrated, eating light and nourishing food, and allowing space for rest can support this process. Consistency over time tends to be more impactful than a single session.",
        ],
      },
    ], "list"),
    imageText(i, c, "salt", "reception", "left", [{
      h: ["**Zoutbad**", "**Bain de sel**", "**Salt bath**"],
      p: [
        ["Wij raden aan om na je sessie een warm zoutbad te nemen omdat het op een eenvoudige manier ontspanning en herstel bevordert.", "Nous vous recommandons de prendre un bain de sel chaud après votre séance : c'est une manière simple de favoriser la détente et la récupération.", "We recommend a warm salt bath after your session as a simple way to support relaxation and recovery."],
        ["Warm water helpt het lichaam te ontspannen, terwijl minerale zouten vaak worden gebruikt om comfort en welzijn te bevorderen na periodes van fysieke of mentale inspanning.", "L'eau chaude aide le corps à se détendre, tandis que les sels minéraux sont souvent utilisés pour favoriser le confort et le bien-être après des périodes d'effort physique ou mental.", "Warm water helps the body relax, while mineral salts are often used to promote comfort and well-being after periods of physical or mental exertion."],
        ["Veel gasten ervaren dit als een rustgevende en verkwikkende aanvulling op hun bezoek.", "Beaucoup d'hôtes le vivent comme un complément apaisant et revigorant à leur visite.", "Many guests experience this as a grounding and restorative addition to their visit."],
        ["Wie geen ligbad heeft raden we aan een voetbad te nemen.", "Si vous n'avez pas de baignoire, nous vous conseillons un bain de pieds.", "If you don't have a bathtub, we recommend taking a foot bath."],
      ],
    }]),
    faq(i, c, "faq", ["Meer informatie", "Plus d'informations", "More information"], FAQ_SESSIONS),
    pricingCta(i, c),
  ];
};

// ---------------------------------------------------------------------------
// Night sessions.
// ---------------------------------------------------------------------------

const NIGHTS: Builder = (i, c) => {
  const single = priceCards(i, c, "prices", L_NIGHT_SINGLE, [BEAM_SKUS.nightAdult, BEAM_SKUS.nightYouth]);
  const packs = priceCards(i, c, "packages", L_NIGHT_PACKS, [BEAM_SKUS.nights3, BEAM_SKUS.nights5, BEAM_SKUS.nights10]);
  const live = single && packs ? [single, packs] : null;
  return [
    imageText(i, c, "intro", "beds", "right", [{ h: ["**12 uur** in de BEAM-ruimte", "**12 heures** dans l'espace BEAM", "**12 hours** in the BEAM environment"], p: [NIGHT_WHEN, NIGHT_BED] }]),
    book(i, c, "quick-night", L_NIGHT, { kind: "book_night" }, NIGHT_NOTE),
    { id: c.id("availability"), type: "availability_preview", kind: "night", days: 14 },
    statement(i, c, "statement-rest", [NIGHT_REST]),
    imageText(i, c, "why", "night", "left", [{ h: ["Waarom **nachtsessies**?", "Pourquoi des **séances de nuit** ?", "Why **night sessions**?"], p: NIGHT_WHY }]),
    rates(i, c, "rates", ["**Prijzen** nachtsessies", "**Tarifs** des séances de nuit", "Night session **prices**"], NIGHT_RATES, !!live),
    ...(live ?? []),
    book(i, c, "book", L_NIGHT, { kind: "book_night" }),
    faq(i, c, "faq", ["Goed om te weten", "Bon à savoir", "Good to know"], FAQ_SESSIONS),
    pricingCta(i, c),
  ];
};

// ---------------------------------------------------------------------------
// Packages & prices: the rates and the three price tabs of beam.be (nights, packages, days).
// ---------------------------------------------------------------------------

const PRICING: Builder = (i, c) => {
  const nightSingle = priceCards(i, c, "night-single", L_NIGHT_SINGLE, [BEAM_SKUS.nightAdult, BEAM_SKUS.nightYouth]);
  const nightPacks = priceCards(i, c, "night-packages", L_NIGHT_PACKS, [BEAM_SKUS.nights3, BEAM_SKUS.nights5, BEAM_SKUS.nights10]);
  const hours = priceCards(i, c, "hours", L_HOURS, [BEAM_SKUS.hours10, BEAM_SKUS.hours20, BEAM_SKUS.hours30, BEAM_SKUS.hours50, BEAM_SKUS.hours100]);
  const daySingle = priceCards(i, c, "day-single", L_DAY_SINGLE, [BEAM_SKUS.dayAdult, BEAM_SKUS.dayYouth]);
  const member = priceCards(i, c, "membership", ["BEAM Membership", "BEAM Membership", "BEAM Membership"], [BEAM_SKUS.membershipYear]);
  const live = !!(nightSingle && nightPacks && hours && daySingle && member);
  const table = (b: Block | null): Block[] => (live && b ? [b] : []);
  return [
    imageText(i, c, "rates", "relax", "right", [{
      h: ["**Tarieven**", "**Tarifs**", "**Rates**"],
      list: [
        ["Het tarief voor 1 uur is **€60**. De standaard **individuele sessie duurt 2 uur**.", "Le tarif pour 1 heure est de **60 €**. La **séance individuelle standard dure 2 heures**.", "The price for one (1) hour is €60. The **standard individual session** is two (2) hours."],
        [
          "Voor wie vaker gebruik wil maken van onze diensten, bieden we **pakketten** aan van 10 tot 100 uur tegen **voordelige tarieven**. Pakketten kunnen met maximaal vijf personen worden gedeeld en blijven 18 maanden geldig.",
          "Pour celles et ceux qui viennent plus souvent, nous proposons des **forfaits** de 10 à 100 heures à des **tarifs avantageux**. Les forfaits peuvent être partagés avec cinq personnes maximum et restent valables 18 mois.",
          "For those who engage more frequently, we offer **packages** ranging from 10 to 100 hours at **discounted rates**. Packages can be shared by up to five people and remain valid for 18 months.",
        ],
        joined(...NIGHT_WHY),
      ],
    }]),
    statement(i, c, "statement-ees", [["Ervaar ons **48 units EES™-systeem**.", "Découvrez notre **système EES™ de 48 unités**.", "Experience our **48-unit EESystem™**."]]),
    rates(i, c, "night-rates", ["Nachtsessies", "Séances de nuit", "Night sessions"], NIGHT_RATES, live),
    ...table(nightSingle),
    ...table(nightPacks),
    rates(i, c, "hour-rates", ["Gereduceerde pakketten", "Forfaits à tarif réduit", "Discounted packages"], HOUR_RATES, live),
    ...table(hours),
    rates(i, c, "day-rates", ["Dagsessies", "Séances de jour", "Day sessions"], [...DAY_RATES, PET_RATE], live),
    ...table(daySingle),
    ...table(member),
    cta(
      i,
      c,
      "cta-membership",
      ["1 volledig jaar van voordelen bij BEAM", "1 année complète d'avantages chez BEAM", "1 full year of benefits with BEAM"],
      [
        "BEAM Membership, €396 per jaar: één gratis nachtsessie of vier dagsessies, tot 20% korting op alle sessies en pakketten en twee exclusieve bijeenkomsten per jaar.",
        "BEAM Membership, 396 € par an : une séance de nuit ou quatre séances de jour offertes, jusqu'à 20 % de réduction sur toutes les séances et tous les forfaits et deux rencontres exclusives par an.",
        "BEAM Membership, €396 a year: one complimentary night session or four day sessions, up to 20% off all sessions and packages and two exclusive gatherings a year.",
      ],
      ["Ontdek het membership", "Découvrir le membership", "Discover the membership"],
      c.page("memberships"),
    ),
    book(i, c, "book-day", L_DAY, { kind: "book_day" }),
    book(i, c, "book-night", L_NIGHT, { kind: "book_night" }),
    book(i, c, "gift", L_GIFT, { kind: "gift" }),
  ];
};

// ---------------------------------------------------------------------------
// Membership: the old /membership/ page.
// ---------------------------------------------------------------------------

const YEAR: L3 = ["1 volledig jaar van voordelen bij BEAM", "1 année complète d'avantages chez BEAM", "1 full year of benefits with BEAM"];
const JOIN: L3 = ["Word BEAM Member", "Devenir membre BEAM", "Become a BEAM Member"];

const MEMBERSHIP: Builder = (i, c) => {
  const price = priceCards(i, c, "price", YEAR, [BEAM_SKUS.membershipYear]);
  return [
    hero(i, c, YEAR, ["BEAM Membership · €396 per jaar", "BEAM Membership · 396 € par an", "BEAM Annual Membership · €396 per year"], { label: JOIN, link: portal("membership") }),
    statement(i, c, "statement-intention", [["Het BEAM membership is in het leven geroepen met **één eenvoudige intentie**:", "Le BEAM membership est né d'**une intention simple** :", "The BEAM membership was created with **one simple intention**:"]]),
    chapter(i, c, "community", [{
      h: [
        "Een **community** van mensen die bewust kiezen voor **herstel**, **helderheid**, **balans** en verbinding.",
        "Une **communauté** de personnes qui choisissent consciemment la **récupération**, la **clarté**, l'**équilibre** et le lien.",
        "To build a **community** of people who consciously choose **restoration**, **clarity**, **balance** and connection.",
      ],
      p: [
        [
          "Vanaf het moment dat we BEAM openden in juni 2024, voelden we dat dit méér was dan een centrum. Er ontstond een gemeenschap van mensen die echt begrepen wat BEAM te bieden heeft en die bleven terugkomen omdat ze voelden dat hier iets wezenlijks gebeurt.",
          "Dès l'ouverture de BEAM en juin 2024, nous avons senti que c'était bien plus qu'un centre. Une communauté est née : des personnes qui comprenaient vraiment ce que BEAM a à offrir et qui revenaient parce qu'elles sentaient qu'il se passait ici quelque chose d'essentiel.",
          "From the moment we opened BEAM in June 2024, we felt that this was more than just a centre. A community of people emerged who genuinely understood what BEAM offers and who kept coming back because they knew that something meaningful was happening here.",
        ],
        [
          "Voor die mensen, en misschien ook voor jou, hebben we het BEAM membership in het leven geroepen: een unieke manier om verbonden te blijven met de ruimte die we samen vormgeven, terwijl je het hele jaar door geniet van waardevolle voordelen en bijzondere momenten.",
          "C'est pour ces personnes, et peut-être aussi pour vous, que nous avons créé le BEAM membership : une manière unique de rester lié à l'espace que nous façonnons ensemble, tout en profitant toute l'année d'avantages précieux et de moments privilégiés.",
          "For those people, and perhaps for you too, we have created something new: BEAM Membership. A unique way to stay connected to the environment we shape together, while enjoying meaningful benefits and special moments throughout the year.",
        ],
      ],
    }]),
    ...photo(c, "circle", "sessions-circle"),
    chapter(i, c, "contents", [{
      h: ["Wat het **membership inhoudt**", "Ce que **comprend le membership**", "What the **membership entails**"],
      p: [
        [
          "Voor **€396** per jaar word je lid van de 'BEAM Community', een veld dat jou het hele jaar door ondersteunt.",
          "Pour **396 €** par an, vous devenez membre de la « BEAM Community », un champ qui vous soutient tout au long de l'année.",
          "For **€396** per year, you become a member of the “BEAM Community,” a network that supports you throughout the year.",
        ],
        ["Je ontvangt onder andere:", "Vous recevez notamment :", "You will receive, among other things:"],
      ],
    }]),
    cards(i, c, "benefits", null, [
      { h: ["Eén gratis nachtsessie of vier dagsessies bij BEAM ter waarde van €420.", "Une séance de nuit offerte ou quatre séances de jour chez BEAM, d'une valeur de 420 €.", "One complimentary night session or four day sessions at BEAM worth €420."], t: ["Bij je inschrijving geef je aan wat je voorkeur heeft.", "Lors de votre inscription, vous indiquez votre préférence.", "Please let us know your preference when you join."] },
      { h: ["Tot 20% korting op alle sessies en pakketten.", "Jusqu'à 20 % de réduction sur toutes les séances et tous les forfaits.", "Up to 20% discount on all sessions and packages."], t: ["De exacte kortingen per pakket worden vermeld in de membership-omgeving.", "Les réductions exactes par forfait sont indiquées dans l'espace membership.", "Exact discounts per package will be confirmed with your membership details."] },
      { h: ["15% korting op producten en evenementen.", "15 % de réduction sur les produits et les événements.", "15% discount on products and events."], t: ["Voor uitzonderlijke events wordt de geldende korting altijd vooraf meegedeeld.", "Pour les événements exceptionnels, la réduction applicable est toujours communiquée à l'avance.", "For exceptional events, the applicable discount will always be communicated in advance."] },
      { h: ["30% korting op ons detoxzout", "30 % de réduction sur notre sel détox", "30% discount on our detox salt"], t: ["", "", ""] },
      { h: ["Twee exclusieve bijeenkomsten per jaar, enkel voor members", "Deux rencontres exclusives par an, réservées aux membres", "Two exclusive members-only gatherings per year"], t: ["", "", ""] },
      { h: ["Maandelijkse loting voor een gratis nachtsessie.", "Un tirage au sort mensuel pour une séance de nuit offerte.", "A monthly draw for a complimentary night session."], t: ["", "", ""] },
    ], "list"),
    imageText(i, c, "value", "community", "left", [
      { p: [["**De waarde van het BEAM membership**", "**La valeur du BEAM membership**", "**The value of BEAM membership**"]] },
      {
        h: ["De waarde van dit membership **overtreft ruimschoots de investering**.", "La valeur de ce membership **dépasse largement l'investissement**.", "The value of this membership far **exceeds your investment**."],
        p: [[
          "Alles bij elkaar genomen is de waarde van dit membership aanzienlijk groter dan de kost ervan. Nog belangrijker is wat het betekent om deel uit te maken van een community die groeit vanuit rust, helderheid en bewustzijn. Een BEAM membership is geen promotie of korting, maar een manier om verbonden te blijven met de omgeving die jou nieuwe energie geeft en inspireert.",
          "Tout bien considéré, la valeur de ce membership dépasse nettement son coût. Plus important encore, c'est ce que signifie faire partie d'une communauté qui grandit dans le calme, la clarté et la conscience. Un BEAM membership n'est ni une promotion ni une réduction, mais une manière de rester lié à l'environnement qui vous redonne de l'énergie et vous inspire.",
          "All things considered, the value of this membership far exceeds your investment. But perhaps even more important than that is what it means to be part of a community that grows from peace, clarity and awareness. BEAM Membership is not a promotion or discount, but a way to stay closer to the environment that restores and inspires you.",
        ]],
      },
    ]),
    price ?? cta(i, c, "price", YEAR, ["BEAM Membership · €396 per jaar", "BEAM Membership · 396 € par an", "BEAM Annual Membership · €396 per year"], JOIN, portal("membership")),
    chapter(i, c, "how", [{
      h: ["**Hoe het werkt**", "**Comment ça marche**", "**How it works**"],
      p: [[
        "De membershipkaart is strikt persoonlijk en dient als sleutel voor alle voordelen voor members. De kaart is één jaar geldig vanaf de activatiedatum en kan verlengd worden indien je dit zou wensen.",
        "La carte de membre est strictement personnelle et sert de clé pour tous les avantages réservés aux membres. Elle est valable un an à partir de la date d'activation et peut être prolongée si vous le souhaitez.",
        "The card is strictly personal and intended as an access key to all membership privileges. It is valid for one year from the date of registration and will be renewed thereafter if you wish to extend it.",
      ]],
    }]),
    cards(i, c, "steps", null, [
      {
        h: ["Je persoonlijke membershipkaart", "Votre carte de membre personnelle", "Your personal membership card"],
        t: [
          "Elke member ontvangt een persoonlijke BEAM membershipkaart: een fysieke kaart die jouw verbinding met de BEAM community symboliseert. De kaarten zijn genummerd als symbool voor wie vanaf het begin deel uitmaakt van de BEAM community.",
          "Chaque membre reçoit une carte de membre BEAM personnelle : une carte physique qui symbolise votre lien avec la communauté BEAM. Les cartes sont numérotées, en symbole de celles et ceux qui font partie de la communauté BEAM depuis le début.",
          "Each member receives a personal BEAM Membership Card, a physical card that symbolises your connection to the field of BEAM.",
        ],
      },
      {
        h: ["Bij je volgende bezoek", "Lors de votre prochaine visite", "On your next visit"],
        t: [
          "Je ontvangt de kaart bij je volgende bezoek aan ons centrum.",
          "Vous recevez la carte lors de votre prochaine visite dans notre centre.",
          "The card will be given to you during your next visit to our center. The cards will be numbered as a small symbol to mark who has been part of the BEAM Community from the very beginning.",
        ],
      },
      {
        h: ["Je voordelen, automatisch", "Vos avantages, automatiquement", "Your benefits, automatically"],
        t: [
          "Vanaf dat moment kan je de kaart gewoon laten zien wanneer je sessies of producten koopt of deelneemt aan evenementen, waarna je voordelen automatisch worden toegepast.",
          "Dès ce moment, il vous suffit de présenter la carte lorsque vous achetez des séances ou des produits ou participez à des événements : vos avantages sont appliqués automatiquement.",
          "From that moment on, you can simply present them whenever you purchase sessions, products or participate in events, and your benefits will be applied automatically.",
        ],
      },
      {
        h: ["Een digitale bevestiging", "Une confirmation numérique", "A digital confirmation"],
        t: [
          "Om alles overzichtelijk te houden, ontvang je bij aanmelding ook een digitale bevestiging met een overzicht van je voordelen, de geldigheidsduur en het contactpunt voor vragen. Zo blijft alles duidelijk, persoonlijk en verbonden.",
          "Pour garder une vue d'ensemble, vous recevez aussi à l'inscription une confirmation numérique avec un récapitulatif de vos avantages, la durée de validité et le point de contact pour vos questions. Ainsi, tout reste clair, personnel et connecté.",
          "To keep track of things, you will also receive a digital confirmation upon joining including a summary of your benefits, the validity period, and a contact point for questions. This way, everything stays clear, personal, and connected.",
        ],
      },
    ], "list"),
    cta(
      i,
      c,
      "cta",
      ["Je kan je membership direct online activeren.", "Vous pouvez activer votre membership directement en ligne.", "Membership can be activated directly online."],
      ["Je membershipkaart ligt voor je klaar bij je volgende bezoek.", "Votre carte de membre vous attendra lors de votre prochaine visite.", "Your card will be waiting for you on your next visit."],
      ["Activeer je BEAM membership", "Activez votre BEAM membership", "Activate your BEAM membership"],
      portal("membership"),
    ),
  ];
};

export const PAGES: Record<string, PageModule> = {
  "day-sessions": { build: DAY_SESSIONS, media: { "sessions-lounge": MEDIA["sessions-lounge"] } },
  nights: { build: NIGHTS },
  pricing: { build: PRICING },
  memberships: { build: MEMBERSHIP, media: { "sessions-circle": MEDIA["sessions-circle"] } },
};
