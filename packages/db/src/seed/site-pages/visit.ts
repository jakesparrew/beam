/**
 * Site pages of the "visit" group: events, experiences, contact and FAQ, rebuilt from beam.be
 * (docs/research/beam-be/: events, ervaringen, contact, faq and their en- versions; the events page
 * also tells the concert series of the concert pages, the contact page the directions of horeca).
 * Dutch and English are the old texts, French is translated from the Dutch.
 * `visit.coverage.test.ts` fails when a line of the old pages goes missing.
 */
import type { Block, RichBlockNode, RichTextNode } from "@beam/core/site";
import {
  BOOK, DAY_NOTE, GIFT_NOTE, L_DAY, L_GIFT, L_NIGHT, NIGHT_NOTE,
  book, cards, chapter, cta, doc, hero, imageText, portal, reviews, rt, statement, videoStory,
  type BuildCtx, type Builder, type L3, type PageModule,
} from "../site-kit";

// ---------------------------------------------------------------------------
// Small rich-text pieces the kit has no helper for: links and a FAQ answer with a list.
// ---------------------------------------------------------------------------

const a = (text: string, href: string): RichTextNode => ({ type: "text", text, marks: [{ type: "link", attrs: { href } }] });
const nodes = (parts: (string | RichTextNode)[]): RichTextNode[] => parts.map((p) => (typeof p === "string" ? { type: "text", text: p } : p));
const para = (parts: (string | RichTextNode)[]): RichBlockNode => ({ type: "paragraph", content: nodes(parts) });
const bullets = (items: (string | RichTextNode)[][]): RichBlockNode => ({ type: "bulletList", content: items.map((it) => ({ type: "listItem", content: [{ type: "paragraph", content: nodes(it) }] })) });
/** Appends rich-text nodes (links, linked lists) to a block built by a kit helper. */
const append = (b: Block, extra: RichBlockNode[]): Block => (b.type === "rich_text" || b.type === "image_text" ? { ...b, doc: { type: "doc", content: [...b.doc.content, ...extra] } } : b);

type Qa = { q: L3; a: L3[]; list?: L3[] };
const faqGroup = (i: number, c: BuildCtx, key: string, heading: L3, items: Qa[]): Block => ({
  id: c.id(key),
  type: "faq",
  heading: heading[i]!,
  items: items.map((x) => ({ question: x.q[i]!, answer: doc(i, [{ p: x.a, list: x.list ?? [] }]) })),
});

const CONTACT_L: L3 = ["Contact", "Contact", "Contact"];

// ---------------------------------------------------------------------------
// Events: the story of BEAM's events and concert series around the live list of upcoming events.
// ---------------------------------------------------------------------------

const EVENTS: Builder = (i, c) => [
  hero(i, c, ["Aankomende evenementen bij BEAM Vitality Center", "Événements à venir au BEAM Vitality Center", "Upcoming events at BEAM Vitality Center"], [
    "BEAM organiseert een zorgvuldig samengestelde reeks conferenties, lezingen en bijzondere ervaringen rond energie, regulatie en menselijke prestaties.",
    "BEAM organise une série soigneusement composée de colloques, de conférences et d'expériences singulières autour de l'énergie, de la régulation et de la performance humaine.",
    "BEAM hosts a curated series of conferences, lectures and immersive gatherings centred on energy, regulation and human performance.",
  ], undefined, "visit-events-hero"),
  imageText(i, c, "intro", "events", "left", [{
    h: ["**Inzicht** en **ervaring**", "**Comprendre** et **ressentir**", "**Insight** and **experience**"],
    p: [
      [
        "Naast vooraanstaande sprekers en practitioners nodigen we ook kunstenaars en muzikanten uit wiens werk zich richt op klank, frequentie en vibratie, wat bijdraagt aan de diepgang en kwaliteit van elke ervaring.",
        "Aux côtés d'intervenants et de praticiens de premier plan, nous invitons aussi des artistes et des musiciens dont le travail porte sur le son, la fréquence et la vibration, ce qui ajoute à la profondeur et à la qualité de chaque expérience.",
        "Alongside leading speakers and practitioners, we invite artists and musicians whose work explores sound, frequency and vibration — contributing to the depth and quality of each experience.",
      ],
      [
        "Elk evenement is zo opgezet dat het **inzicht en ervaring combineert**, binnen de unieke context van de BEAM-omgeving.",
        "Chaque événement est conçu pour **allier compréhension et expérience**, dans le contexte unique de l'environnement BEAM.",
        "Each event is designed to **combine insight with experience**, within the unique conditions of the BEAM environment.",
      ],
    ],
  }]),
  { id: c.id("agenda"), type: "events_list", heading: ["Aankomende events", "Événements à venir", "Upcoming events"][i]!, limit: 12, showFull: true },
  chapter(i, c, "series", [{
    h: ["De BEAM **Internationale Concertreeks**", "La **série internationale de concerts** BEAM", "The BEAM **International Concert Series**"],
    p: [
      ["Bij BEAM geloven we dat sommige ervaringen iets in beweging brengen wat woorden niet kunnen.", "Chez BEAM, nous croyons que certaines expériences mettent en mouvement ce que les mots ne peuvent pas atteindre.", "At BEAM, we recognise that certain experiences set something in motion that words cannot."],
      ["Daarom lanceren wij de BEAM Internationale Concertreeks.", "C'est pourquoi nous lançons la série internationale de concerts BEAM.", "That is why we are launching the BEAM International Concert Series."],
      ["**Een zorgvuldig samengestelde selectie van internationale artiesten die mensen raken, verbinden en inspireren.**", "**Une sélection soigneusement composée d'artistes internationaux qui touchent, rassemblent et inspirent.**", "**A carefully curated selection of international artists who move, connect and inspire.**"],
    ],
  }]),
  cards(i, c, "artists", null, [
    { h: ["Praful", "Praful", "Praful"], t: ["19 september 2026 · Bansuri en saxofoon. Een muzikale reis naar een plek die woorden niet kunnen bereiken.", "19 septembre 2026 · Bansuri et saxophone. Un voyage musical vers un lieu que les mots ne peuvent atteindre.", "19 September 2026 · Bansuri and saxophone. A musical journey to a place that words cannot reach."], img: "visit-praful" },
    { h: ["Alexander Mercks", "Alexander Mercks", "Alexander Mercks"], t: ["31 oktober 2026 · Handpan. Een muzikale reis naar een plek voorbij woorden.", "31 octobre 2026 · Handpan. Un voyage musical vers un lieu au-delà des mots.", "31 October 2026 · Handpan. A musical journey to a place beyond words."], img: "visit-mercks" },
    { h: ["Amber Haddad & Band", "Amber Haddad & Band", "Amber Haddad & Band"], t: ["5 december 2026 · Kerstconcert. Een warme kerstviering vol muziek, magie en verbinding.", "5 décembre 2026 · Concert de Noël. Une chaleureuse fête de Noël pleine de musique, de magie et de partage.", "5 December 2026 · Christmas concert. A warm Christmas celebration full of music, magic and connection."], img: "visit-amber" },
  ]),
  imageText(i, c, "setting", "night", "right", [{
    h: ["Muziek in een **unieke setting**", "La musique dans un **cadre unique**", "Music in a **unique setting**"],
    p: [
      ["Sommige plekken laten je onmiddellijk vertragen en nodigen uit tot rust, aanwezigheid en verbinding.", "Certains lieux vous font immédiatement ralentir et invitent au calme, à la présence et au lien.", "Some places instantly make you slow down and invite you to relax, be present and connect."],
      ["BEAM is zo een plek. Ontworpen vanuit één eenvoudige gedachte:", "BEAM est l'un de ces lieux. Conçu à partir d'une idée simple :", "BEAM is one such place. Designed around a single, simple idea:"],
      ["**De kwaliteit van een ervaring wordt niet alleen bepaald door wat er gebeurt, maar ook door de omgeving waarin je die beleeft.**", "**La qualité d'une expérience ne dépend pas seulement de ce qui se passe, mais aussi de l'environnement dans lequel vous la vivez.**", "**The quality of an experience is determined not only by what happens, but also by the setting in which you have it.**"],
      ["Daarom reizen bezoekers uit België, Nederland, Duitsland, Frankrijk en ver daarbuiten naar BEAM om bewust tijd door te brengen in onze bijzondere ruimte.", "C'est pourquoi des visiteurs de Belgique, des Pays-Bas, d'Allemagne, de France et de bien plus loin viennent à BEAM pour passer consciemment du temps dans notre espace singulier.", "That is why visitors from Belgium, the Netherlands, Germany, France and far beyond travel to BEAM to consciously spend time in our special space."],
      ["Wanneer honderden subtiele elementen — licht, ruimte, akoestiek, aandacht, aanwezigheid en de unieke energetische omgeving van BEAM — samenkomen, ontstaat een ervaring die anders voelt dan een traditioneel concert.", "Lorsque des centaines d'éléments subtils — la lumière, l'espace, l'acoustique, l'attention, la présence et l'environnement énergétique unique de BEAM — se rejoignent, naît une expérience qui ne ressemble pas à un concert traditionnel.", "When hundreds of subtle elements — light, space, acoustics, attention, presence and BEAM’s unique energetic atmosphere — come together, the result is an experience that feels different from a traditional concert."],
    ],
  }]),
  statement(i, c, "statement-deeper", [
    ["Niet groter of luider, maar **dieper**.", "Pas plus grand ni plus fort, mais **plus profond**.", "Not bigger or louder, but **deeper**."],
    ["Geen concert dat plaatsvindt in BEAM, maar een ervaring die **alleen in BEAM** kan plaatsvinden.", "Pas un concert qui a lieu chez BEAM, mais une expérience qui ne peut avoir lieu **que chez BEAM**.", "Not a concert taking place at BEAM, but an experience that can **only take place at BEAM**."],
  ]),
  cards(i, c, "different", ["Waarom een concertavond bij BEAM anders is", "Pourquoi une soirée de concert chez BEAM est différente", "Why an evening at BEAM is different"], [
    { h: ["Intiem publiek", "Un public restreint", "Intimate audience"], t: ["Om de kwaliteit van de ervaring te bewaren, wordt het aantal aanwezigen bewust beperkt.", "Pour préserver la qualité de l'expérience, le nombre de participants est volontairement limité.", "To ensure the quality of the experience, the number of attendees is deliberately limited."] },
    { h: ["Gedeelde ervaring", "Une expérience partagée", "Shared experience"], t: ["Wanneer mensen samen luisteren, ontstaat iets wat moeilijk in woorden te vatten is. Een gevoel van verbondenheid dat nog lang nazindert nadat de laatste noot is gespeeld.", "Lorsque des personnes écoutent ensemble, il naît quelque chose de difficile à mettre en mots. Un sentiment de lien qui résonne longtemps après la dernière note.", "When people listen together, something happens that is difficult to put into words. A sense of connection that lingers long after the final note has been played."] },
    { h: ["Unieke omgeving", "Un cadre unique", "A unique setting"], t: ["Elke artiest brengt zijn muziek naar een van Europa’s meest bijzondere omgevingen voor rust, aanwezigheid en menselijke vitaliteit.", "Chaque artiste apporte sa musique dans l'un des environnements les plus singuliers d'Europe, dédié au calme, à la présence et à la vitalité humaine.", "Each artist brings their music to one of Europe’s most extraordinary settings for tranquillity, mindfulness and human vitality."] },
  ], "list"),
  chapter(i, c, "venue", [{
    h: ["Meer dan een **concertlocatie**", "Bien plus qu'une **salle de concert**", "More than just a **concert venue**"],
    p: [
      ["BEAM werd ontworpen vanuit één fundamenteel inzicht: **Mensen herstellen wanneer de omgeving dit toelaat.**", "BEAM a été conçu à partir d'une conviction fondamentale : **les personnes se rétablissent quand leur environnement le permet.**", "BEAM was designed based on one fundamental insight: **People recover when their environment allows them to.**"],
      ["Daarom creëren wij ruimtes waar rust, aanwezigheid en verbinding centraal staan.", "C'est pourquoi nous créons des espaces où le calme, la présence et le lien occupent une place centrale.", "That is why we create spaces where tranquillity, presence and connection take centre stage."],
      ["Vandaag behoort BEAM tot de grootste en meest bezochte EESystem-omgevingen van Europa.", "Aujourd'hui, BEAM compte parmi les environnements EESystem les plus grands et les plus fréquentés d'Europe.", "Today, BEAM is one of the largest and most visited EESystem environments in Europe."],
    ],
  }]),
  cards(i, c, "past", ["Voorbije events", "Événements passés", "Past events"], [
    { h: ["The Energy that Heals", "The Energy that Heals", "The Energy that Heals"], t: ["BEAM Vitality Center · 1 november 2026. Een exclusieve livestream van de documentaire voor onze members: wat als herstel verder gaat dan wat we kunnen zien?", "BEAM Vitality Center · 1er novembre 2026. La diffusion exclusive du documentaire pour nos membres : et si la récupération allait au-delà de ce que l'on peut voir ?", "BEAM Vitality Center · 1 November 2026. An exclusive live stream of the documentary for our members: what if recovery goes beyond what we can see?"] },
    { h: ["Lezingen met Live The Connection", "Conférences avec Live The Connection", "Lectures with Live The Connection"], t: ["Je bent niet moe. Je systeem is uit balans. In Gent, Deinze en Brecht: waarom het lichaam soms niet meer mee kan, en wat er verandert wanneer de juiste voorwaarden worden hersteld.", "Vous n'êtes pas fatigué. Votre système est déséquilibré. À Gand, Deinze et Brecht : pourquoi le corps ne suit parfois plus, et ce qui change lorsque les bonnes conditions sont rétablies.", "You're not tired. Your system is out of balance. In Ghent, Deinze and Brecht: why the body sometimes cannot keep up anymore, and what changes when the right conditions are restored."] },
    { h: ["Gratis online webinars", "Webinaires gratuits en ligne", "Free online webinars"], t: ["Je bent niet moe. Je systeem is uit balans. Waarom je je uitgeput blijft voelen, zelfs als je rust, en wat je lichaam nodig heeft om weer op te laden.", "Vous n'êtes pas fatigué. Votre système est déséquilibré. Pourquoi vous restez épuisé même lorsque vous vous reposez, et ce dont votre corps a besoin pour se recharger.", "You're not tired. Your system is out of balance. Why you keep feeling exhausted even when you rest, and what your body needs to recharge."] },
    { h: ["Viering 2-jarig bestaan BEAM", "Les 2 ans de BEAM", "BEAM’s 2nd Anniversary Celebration"], t: ["BEAM Vitality Center · 30 juli 2026. Live muziek van Amber & Band, inspirerende verhalen en de unieke sfeer van BEAM: een avond vol verbinding, inspiratie en dankbaarheid.", "BEAM Vitality Center · 30 juillet 2026. La musique live d'Amber & Band, des histoires inspirantes et l'atmosphère unique de BEAM : une soirée de partage, d'inspiration et de gratitude.", "BEAM Vitality Center · 30 July 2026. Live music by Amber & Band, inspiring stories and the unique atmosphere of BEAM: an evening full of connection, inspiration and gratitude."] },
    { h: ["Groep Chanting & Meditatie", "Chant et méditation en groupe", "Group Chanting & Meditation"], t: ["BEAM Vitality Center · 31 mei 2026. Samen zingen en mediteren in de BEAM-ruimte.", "BEAM Vitality Center · 31 mai 2026. Chanter et méditer ensemble dans l'espace BEAM.", "BEAM Vitality Center · 31 May 2026. Chanting and meditating together in the BEAM space."] },
    { h: ["Klankbad met Bruno Rodenbach", "Bain sonore avec Bruno Rodenbach", "Sound bath with Bruno Rodenbach"], t: ["BEAM Vitality Center · 29 maart 2026. Een intiem en diep ontspannend klankbad: een uniek klankconcert dat ontstaat in het moment.", "BEAM Vitality Center · 29 mars 2026. Un bain sonore intime et profondément relaxant : un concert unique qui naît dans l'instant.", "BEAM Vitality Center · 29 March 2026. An intimate, deeply relaxing sound bath: a unique sound concert that emerges in the moment."] },
  ]),
  cta(i, c, "cta", ["Mis geen enkel event", "Ne manquez aucun événement", "Never miss an event"], [
    "Abonneer je onderaan deze pagina op onze nieuwsbrief en ontvang als eerste de nieuwe data. Een eigen event of een privé-ervaring in de BEAM-ruimte? We denken graag met je mee.",
    "Inscrivez-vous à notre newsletter en bas de cette page et recevez en premier les nouvelles dates. Un événement à vous ou une expérience privée dans l'espace BEAM ? Nous y réfléchissons volontiers avec vous.",
    "Subscribe to our newsletter at the bottom of this page and be the first to hear about new dates. Planning your own event or a private experience in the BEAM space? We are happy to help.",
  ], ["Neem contact op", "Contactez-nous", "Get in touch"], c.page("contact")),
];

// ---------------------------------------------------------------------------
// Experiences: guests' own words (videos, written reflections, short quotes) and the Google reviews.
// ---------------------------------------------------------------------------

const VIDEOS: { youtube: string; q: L3; who: string; what: L3 }[] = [
  { youtube: "https://youtu.be/R1o8QF7xNOk", q: ["‘Het werkt in op mijn hoofd.’", "« Ça agit sur ma tête. »", "‘It works on my head.’"], who: "Carine Cockx", what: ["Herstellende van burnout", "En convalescence après un burn-out", "Recovering from burnout"] },
  { youtube: "https://youtu.be/Rw3lAkiv3Hc", q: ["‘Als er iets gebeurt met mijn energie kan ik altijd naar hier komen om op te laden.’", "« Quand quelque chose arrive à mon énergie, je peux toujours venir ici me recharger. »", "‘If something happens to my energy, I can always come here to recharge.’"], who: "Jeroen Vandenbossche", what: ["Herstellende van burnout", "En convalescence après un burn-out", "Recovering from burnout"] },
  { youtube: "https://www.youtube.com/shorts/RG-IDifKScE", q: ["‘Reborn en opgeladen.’", "« Comme né à nouveau, et rechargé. »", "‘Reborn and recharged.’"], who: "Kevin Pauly", what: ["Bewuste ondernemer, aanwezige partner en vader van 2", "Entrepreneur conscient, partenaire présent et père de deux enfants", "Conscious entrepreneur, present partner and father of two"] },
  { youtube: "https://www.youtube.com/shorts/zAkZJth5sM4", q: ["‘Het heeft een groot effect op mij.’", "« Cela a un grand effet sur moi. »", "‘It has a profound effect on me.’"], who: "Regine Thielemans", what: ["Leerkracht", "Enseignante", "Teacher"] },
  { youtube: "https://www.youtube.com/shorts/B9Lb4WapDfU", q: ["‘Mijn stemming is aanzienlijk veranderd.’", "« Mon humeur a considérablement changé. »", "‘My mood has changed significantly.’"], who: "Erika Naftali", what: ["Enthousiaste BEAM-bezoeker", "Visiteuse enthousiaste de BEAM", "Enthusiastic BEAM visitor"] },
];

const REFLECTIONS: { h: L3; t: L3; who: string; what: L3 }[] = [
  {
    h: ["Mentale reset & nieuwe verbindingen", "Remise à zéro mentale & nouvelles connexions", "Mental reset & new connections"],
    t: [
      "De ontvangst van het team is warm en hartelijk. Ik voel altijd veel bewegingen in mijn brein, energie in mijn hoofd, alsof er nieuwe verbindingen worden gelegd of iets wordt gereset.",
      "L'accueil de l'équipe est chaleureux et cordial. Je ressens toujours beaucoup de mouvement dans mon cerveau, de l'énergie dans ma tête, comme si de nouvelles connexions se créaient ou que quelque chose se réinitialisait.",
      "The team’s welcome is warm and heartfelt. I always feel a lot of activity in my brain, energy in my head—as if new connections are being formed or something is being reset.",
    ],
    who: "Hilde Josephy",
    what: ["gelukkige mama van vier en gelukkige oma van drie", "maman heureuse de quatre enfants et grand-mère heureuse de trois petits-enfants", "happy mother of four and happy grandmother of three"],
  },
  {
    h: ["Technologie & menselijke warmte", "Technologie & chaleur humaine", "Technology & human warmth"],
    t: [
      "Licht en warmte… dat zijn woorden die spontaan in me opkomen als ik aan BEAM denk. Hier staan twee vormen van energie naast elkaar die elkaar versterken: technologische kracht én bewuste menselijke aanwezigheid. Samen vormen ze iets dat groter is dan woorden kunnen vatten. En doet me iedere keer opnieuw terugkeren naar BEAM.",
      "Lumière et chaleur… ce sont les mots qui me viennent spontanément quand je pense à BEAM. Ici, deux formes d'énergie se côtoient et se renforcent : la puissance technologique et une présence humaine consciente. Ensemble, elles forment quelque chose de plus grand que ce que les mots peuvent saisir. Et cela me ramène à BEAM, encore et encore.",
      "Light and warmth… those are the words that spontaneously come to mind when I think of BEAM. Here, two forms of energy stand side by side, reinforcing each other: technological power and conscious human presence. Together, they form something greater than words can capture. And it keeps drawing me back to BEAM, time and time again.",
    ],
    who: "Stijn Cnockaert",
    what: ["auteur, lifecoach en massagetherapeut", "auteur, coach de vie et massothérapeute", "author, life coach, and massage therapist"],
  },
  {
    h: ["Oase van rust & magie", "Une oasis de calme & de magie", "An oasis of peace & magic"],
    t: [
      "BEAM is echt een ware oase van rust, licht en magie. Zodra je binnenstapt, voel je de serene sfeer die je onmiddellijk tot rust brengt. De inrichting is echt heel mooi gedaan en ik voelde me meteen op mijn gemak. De eigenaars zijn buitengewoon hartelijk en hun passie straalt door in alles wat ze doen. Hun toewijding aan het welzijn van hun klanten is duidelijk merkbaar.",
      "BEAM est une véritable oasis de calme, de lumière et de magie. Dès que l'on entre, on ressent une atmosphère sereine qui apaise immédiatement. L'aménagement est très réussi et je me suis tout de suite sentie à l'aise. Les propriétaires sont d'une chaleur exceptionnelle et leur passion transparaît dans tout ce qu'ils font. Leur dévouement au bien-être de leurs clients se ressent clairement.",
      "BEAM truly is an oasis of peace, light, and magic. The moment you step inside, you feel the serene atmosphere that immediately brings you to rest. The interior is beautifully designed, and I felt at ease right away. The owners are exceptionally warm, and their passion shines through in everything they do. Their dedication to the well-being of their clients is clearly felt.",
    ],
    who: "Eva Bossaer",
    what: ["fitness coach en gezondheidsexperte", "coach sportive et experte en santé", "fitness coach and health expert"],
  },
  {
    h: ["Diepe rust & gewoon ‘zijn’", "Repos profond & simplement « être »", "Deep rest & simply ‘being’"],
    t: [
      "Reeds van de eerste keer voelde ik de energie van het EESystem dat als een dekentje over mij heen werd gelegd. Een diepe rust kwam over mij, een ‘thuisgevoel’. Ik kon heel gemakkelijk in het nu zijn, zonder gedachten… gewoon ‘zijn’ in alle rust, wat voor velen heel moeilijk is in onze drukke samenleving.",
      "Dès la première fois, j'ai senti l'énergie de l'EESystem se poser sur moi comme une petite couverture. Un repos profond m'a envahie, un sentiment d'être chez moi. Je pouvais très facilement être dans l'instant, sans pensées… simplement « être » dans le calme, ce qui est très difficile pour beaucoup dans notre société agitée.",
      "From the very first session, I felt the energy of the EESystem like a blanket gently laid over me. A deep sense of calm came over me—a feeling of being at home. I could easily be in the present moment, without thoughts… simply ‘being’ in complete stillness, which is so rare in our busy society.",
    ],
    who: "Vera Vermaercke",
    what: ["tolk Vlaamse Gebarentaal", "interprète en langue des signes flamande", "interpreter"],
  },
  {
    h: ["Ontspanning zonder inspanning", "Se détendre sans effort", "Relaxation without effort"],
    t: [
      "Geest en lichaam worden ondergedompeld in een hele rustige, helende, hoge energie. Je kan niet anders dan diep ontspannen hier en het beste is dat je zelf niks moet doen. Het EES-systeem is een middel om mijn heling te versnellen.",
      "L'esprit et le corps sont plongés dans une énergie très calme, apaisante et élevée. Impossible de ne pas se détendre profondément ici, et le mieux, c'est qu'on n'a rien à faire soi-même. L'EESystem est un moyen d'accélérer ma guérison.",
      "Mind and body are immersed in a very calm, healing, high-frequency energy. You can’t help but deeply relax here—and the best part is that you don’t have to do anything yourself. The EESystem is a tool that helps accelerate my healing.",
    ],
    who: "Bart B.",
    what: ["herstellende van burn-out", "en convalescence après un burn-out", "recovering from burnout"],
  },
  {
    h: ["Energie & focus", "Énergie & concentration", "Energy & focus"],
    t: [
      "Het effect is moeilijk onder woorden te brengen. Ik voel mij meer gegrond en ook dichterbij mijn authentieke zelf. Ik ervaar ook een boost in energie en voel mij beduidend gelukkiger. ADD symptomen verminderen aanzienlijk. Ik voel mij rustig en vol liefde.",
      "L'effet est difficile à mettre en mots. Je me sens plus ancrée et plus proche de mon moi authentique. Je ressens aussi un regain d'énergie et je me sens nettement plus heureuse. Mes symptômes de TDA diminuent considérablement. Je me sens calme et pleine d'amour.",
      "The effect is difficult to put into words. I feel more grounded and closer to my authentic self. I also experience a boost in energy and feel noticeably happier. My ADD symptoms decrease significantly. I feel calm and full of love.",
    ],
    who: "Regine Thielemans",
    what: ["leerkracht", "enseignante", "teacher"],
  },
];

/** Short quotes of guests; Elizabeth J. wrote in English, so her words stay English on every locale. */
const QUOTES: { q: L3; who: string }[] = [
  { q: ["BEAM is een gamechanger die me fysieke verlichting brengt en diepe rust.", "BEAM change la donne : il m'apporte un soulagement physique et un repos profond.", "BEAM is a gamechanger that brings me physical relief and deep relaxation."], who: "Talitha C." },
  { q: ["Heb weer meer energie en het brengt ruimte in mijn hoofd om me te focussen op dingen die echt belangrijk zijn.", "J'ai retrouvé de l'énergie, et cela libère de l'espace dans ma tête pour me concentrer sur ce qui compte vraiment.", "I have more energy again, and it creates space in my mind to focus on what truly matters."], who: "Hanneke S." },
  { q: ["Je komt binnen en voelt onmiddellijk de rust over u komen. Christophe & Sanne & Jonathan zijn de kers op de taart.", "On entre et on sent aussitôt le calme nous envahir. Christophe & Sanne & Jonathan sont la cerise sur le gâteau.", "You walk in and immediately feel a sense of calm wash over you. Christophe & Sanne & Jonathan are the cherry on top."], who: "Caroline D." },
  { q: ["Een sessie is een rustmoment, me time, tijd voor een meditatie.", "Une séance est un moment de repos, du temps pour soi, un temps de méditation.", "A session is a moment of rest, me-time, time for meditation."], who: "Hilde J." },
  { q: ["Na de tweede en derde nacht een moeilijk te omschrijven lichtheid, klaarheid.", "Après la deuxième et la troisième nuit, une légèreté et une clarté difficiles à décrire.", "After the second and third night, I experienced a lightness and clarity that are hard to describe."], who: "Marina D." },
  { q: ["Voel me altijd fantastisch als ik ben blijven slapen.", "Je me sens toujours fantastique quand je suis resté dormir.", "I always feel fantastic when I stay overnight."], who: "Jerry G." },
  { q: ["Technologische kracht én bewuste menselijke aanwezigheid.", "Une puissance technologique alliée à une présence humaine consciente.", "Technological power combined with conscious human presence."], who: "Stijn C." },
  { q: ["Every time I leave, I feel like a new person, relaxed yet rejuvenated.", "Every time I leave, I feel like a new person, relaxed yet rejuvenated.", "Every time I leave, I feel like a new person, relaxed yet rejuvenated."], who: "Elizabeth J." },
];

const EXPERIENCES: Builder = (i, c) => [
  hero(i, c, ["EESystem-ervaringen bij BEAM Vitality Center", "Expériences EESystem au BEAM Vitality Center", "What guests experience at BEAM Vitality Center"], [
    "145 geverifieerde vijfsterrenreviews op Google.",
    "145 avis cinq étoiles vérifiés sur Google.",
    "145 five-star verified reviews on Google.",
  ], { label: BOOK, link: portal("book_day") }),
  imageText(i, c, "intro", "portrait", "right", [{
    h: ["Mensen beschrijven hun BEAM-ervaring **op verschillende manieren**.", "Chacun décrit son expérience BEAM **à sa manière**.", "People describe their time at BEAM in **different ways**."],
    p: [
      ["Iedereen die bij BEAM binnenkomt, heeft zijn eigen verhaal, zijn eigen behoeften en zijn eigen verwachtingen. Wat mensen achteraf delen, is puur persoonlijk: spontaan, ongefilterd en authentiek.", "Chaque personne qui entre chez BEAM arrive avec sa propre histoire, ses propres besoins et ses propres attentes. Ce qu'elle partage ensuite est purement personnel : spontané, sans filtre et authentique.", "Every person who enters BEAM arrives with their own story, their own needs and their own expectations. What they share afterwards is theirs alone — unscripted, unfiltered and entirely their own."],
      ["**Dit zijn geen getuigenissen.** Het zijn persoonlijke verhalen over wat er gebeurt als het lichaam de omstandigheden krijgt die het nodig heeft om zichzelf te herstellen.", "**Ce ne sont pas des témoignages.** Ce sont des récits personnels de ce qui se passe lorsque le corps reçoit les conditions dont il a besoin pour se rétablir.", "**These are not testimonials.** They are accounts of what happens when the body is given the conditions it needs to restore itself."],
      ["Sommigen spreken over fysiek welzijn en een diepere slaap. Anderen merken meer helderheid in hun denken of een stabieler energieniveau. Voor sommigen is het moeilijk om het überhaupt onder woorden te brengen.", "Certains parlent de bien-être physique et d'un sommeil plus profond. D'autres remarquent une pensée plus claire ou un niveau d'énergie plus stable. Pour d'autres encore, il est difficile de le mettre en mots.", "Some speak of physical ease and deeper sleep. Others notice clarity of thought or a more stable sense of energy. Some find it difficult to put into words at all."],
    ],
  }]),
  statement(i, c, "statement-return", [["Wat steeds terugkomt, is de **kwaliteit van de ervaring** en de **wens om terug te komen**.", "Ce qui revient toujours, c'est la **qualité de l'expérience** et l'**envie de revenir**.", "What is consistent is the **quality of the experience** and the **desire to return**."]]),
  videoStory(i, c, "videos", "-8tzHbwZSZ8", ["Lutgart Hanssens, hersteld van burnout", "Lutgart Hanssens, rétablie d'un burn-out", "Lutgart Hanssens, recovered from burnout"], "relax", [
    {
      h: ["**Video-ervaringen**", "**Expériences en vidéo**", "**Video experiences**"],
      p: [
        ["**Onze gasten aan het woord**", "**Nos hôtes prennent la parole**", "**Heard directly from those who have been here.**"],
        ["Enkele ervaringen die gasten hebben gedeeld na hun verblijf in BEAM. Iedereen spreekt vanuit zijn of haar eigen perspectief, zonder script.", "Quelques expériences partagées par des hôtes après leur passage chez BEAM. Chacun parle de son propre point de vue, sans script.", "A selection of experiences shared by guests following their time at BEAM. Each person speaks from their own perspective — without prompt or script."],
      ],
    },
    { h3: ["‘In het begin was ik heel sceptisch.’", "« Au début, j'étais très sceptique. »", "‘In the beginning, I was very skeptical.’"], p: [["**Lutgart Hanssens**", "**Lutgart Hanssens**", "**Lutgart Hanssens**"], ["Hersteld van burnout", "Rétablie d'un burn-out", "Recovered from burnout"]] },
  ]),
  cards(i, c, "more-videos", null, VIDEOS.map((v) => ({ h: v.q, t: [`${v.who} · ${v.what[0]} · video`, `${v.who} · ${v.what[1]} · vidéo`, `${v.who} · ${v.what[2]} · video`] as L3, link: { kind: "url" as const, href: v.youtube } }))),
  chapter(i, c, "reflections-intro", [{
    h: ["**Geschreven** reflecties", "Réflexions **écrites**", "**Written** reflections"],
    p: [
      ["**In hun eigen woorden**", "**Avec leurs propres mots**", "**In their own words**"],
      ["Korte reflecties van gasten na hun verblijf in BEAM, met toestemming gedeeld en weergegeven zoals we ze ontvangen hebben.", "De courtes réflexions d'hôtes après leur passage chez BEAM, partagées avec leur accord et reproduites telles que nous les avons reçues.", "Short reflections from guests following their time at BEAM. Shared with permission and presented as received."],
    ],
  }]),
  cards(i, c, "reflections", null, REFLECTIONS.map((r) => ({ h: r.h, t: [0, 1, 2].map((n) => `${r.t[n]} — ${r.who}, ${r.what[n]}`) as L3 }))),
  chapter(i, c, "words", [{
    h: ["In hun **eigen woorden**", "Avec leurs **propres mots**", "In their **own words**"],
    p: [
      ["**Sommige dingen kan je het beste eenvoudig verwoorden.**", "**Certaines choses se disent le mieux simplement.**", "**Some things are better said simply.**"],
      ["Een selectie van uitspraken die ons zijn bijgebleven, uit de ervaringen van gasten die in BEAM zijn geweest.", "Une sélection de phrases qui nous sont restées, tirées des expériences d'hôtes venus chez BEAM.", "A selection of phrases that have stayed with us, drawn from the experiences of guests who have spent time at BEAM."],
    ],
  }]),
  // White cards in a 4-column grid; the `icons` layout without an icon is the plain white card.
  { id: c.id("quotes"), type: "card_grid", layout: "icons", cards: QUOTES.map((x) => ({ heading: x.q[i]!, text: x.who })) },
  ...reviews(i, c, "review"),
  cta(i, c, "cta", ["Klaar om het zelf te ervaren?", "Prêt à le vivre vous-même ?", "Ready to experience it for yourself?"], [
    "De beste manier om te ontdekken wat BEAM te bieden heeft, is door er zelf wat tijd door te brengen. Elke ervaring begint met één sessie.",
    "La meilleure façon de découvrir ce que BEAM a à offrir est d'y passer vous-même un peu de temps. Chaque expérience commence par une séance.",
    "The most direct way to understand what BEAM offers is to spend time here. Every experience begins with a single session.",
  ], BOOK, portal("book_day")),
  rt(i, c, "disclaimer", [{
    h3: ["Disclaimer", "Avertissement", "Disclaimer"],
    p: [[
      "BEAM biedt uitsluitend omgevings- en ervaringsgerichte diensten aan. Het Energy Enhancement System™ is geen medisch apparaat en stelt geen diagnoses, behandelt niet en vervangt geen medische zorg. Individuele ervaringen kunnen variëren.",
      "BEAM propose exclusivement des services liés à l'environnement et à l'expérience. L'Energy Enhancement System™ n'est pas un dispositif médical : il ne pose pas de diagnostic, ne traite pas et ne remplace pas les soins médicaux. Les expériences individuelles peuvent varier.",
      "BEAM provides environmental and experiential services only. The Energy Enhancement System™ is not a medical device and does not diagnose, treat or replace medical care. Individual experiences may vary.",
    ]],
  }]),
];

// ---------------------------------------------------------------------------
// Contact: how to reach BEAM, the contact form, opening hours, directions and social media.
// ---------------------------------------------------------------------------

const SOCIAL: [string, string][] = [
  ["Facebook", "https://www.facebook.com/beamvitalitycenter"],
  ["Instagram", "https://www.instagram.com/beamvitalitycenter"],
  ["X", "https://x.com/beamvitality"],
  ["LinkedIn", "https://www.linkedin.com/company/beamvitalitycenter"],
  ["YouTube", "https://www.youtube.com/@beamvitalitycenter"],
  ["WhatsApp", "https://wa.me/32469413111"],
];

const CONTACT: Builder = (i, c) => [
  append(chapter(i, c, "talk", [{
    h: ["**Neem contact** met ons op", "**Contactez**-nous", "**Let’s talk**"],
    p: [
      ["Of je nu nieuwsgierig bent naar wat we doen, graag meer wilt leren of gewoon iets wilt zeggen, je kan ons hier een berichtje sturen.", "Que vous soyez curieux de ce que nous faisons, que vous souhaitiez en savoir plus ou simplement nous dire un mot, vous pouvez nous envoyer un message ici.", "Whether you’re curious about what we do, want to learn more, or just want to say hi, you can send us a message here."],
      ["Voel je vrij om contact op te nemen. **We antwoorden binnen de 48 uur!**", "N'hésitez pas à nous contacter. **Nous répondons dans les 48 heures !**", "Please feel free to contact us. **We’ll get back to you within 48 hours!**"],
    ],
  }]), [bullets([
    [a("+32 469 41 31 11", "https://wa.me/32469413111"), " (WhatsApp)"],
    [a("+32 9 39 12 422", "tel:+3293912422"), [" (9u tot 19u)", " (de 9 h à 19 h)", " (9am to 7pm)"][i]!],
    [a("welcome@beam.be", "mailto:welcome@beam.be")],
    [["Vibrant Lifestyle Collective BV, Xavier de Cocklaan 70, bus 7, 9831 Sint-Martens-Latem, België", "Vibrant Lifestyle Collective BV, Xavier de Cocklaan 70, boîte 7, 9831 Sint-Martens-Latem, Belgique", "Vibrant Lifestyle Collective BV, Xavier de Cocklaan 70, bus 7, 9831 Sint-Martens-Latem, Belgium"][i]!],
    [["BTW-nummer: BE0805085449", "Numéro de TVA : BE0805085449", "VAT number: BE0805085449"][i]!],
  ])]),
  rt(i, c, "form-title", [{ h: ["Contact BEAM Vitality Center Sint-Martens-Latem", "Contacter BEAM Vitality Center à Sint-Martens-Latem", "Contact BEAM Vitality Center Sint-Martens-Latem"] }]),
  { id: c.id("form"), type: "form_embed", formSlug: "contact" },
  { id: c.id("contact"), type: "contact_details", showAddress: false, showPhone: false, showEmail: false, showOpeningHours: true },
  imageText(i, c, "directions", "location", "right", [
    {
      h: ["Zo vind je **ons**", "Comment nous **trouver**", "How to **find us**"],
      p: [
        ["Ons centrum is gelegen in het Latem Business Park, op de **Xavier de Cocklaan 70, bus 7, 9831 Sint-Martens-Latem**.", "Notre centre se trouve dans le Latem Business Park, **Xavier de Cocklaan 70, boîte 7, 9831 Sint-Martens-Latem**.", "Our center is located in the Latem Business Park, at **70 Xavier de Cocklaan, bus 7, 9831 Sint-Martens-Latem**."],
        ["Het park bestaat uit vier identieke gebouwen. Als je vanuit Gent komt, vind je ons in het tweede blok (het derde blok als je uit de richting van Deinze komt), helemaal achteraan op de eerste verdieping. Je herkent ons gebouw aan de stickers op de ramen.", "Le parc compte quatre bâtiments identiques. En venant de Gand, vous nous trouvez dans le deuxième bloc (le troisième si vous venez de Deinze), tout au fond, au premier étage. Vous reconnaîtrez notre bâtiment aux autocollants sur les fenêtres.", "The park consists of four identical buildings. If you are coming from Ghent, you will find us in the second block (the third block if you are coming from the direction of Deinze), at the very back on the first floor. You can recognize our building by the stickers on the windows."],
        ["Bij aankomst loop je door een grote glazen deur (deze staat altijd open) naar de lift. Druk op de bel van **BEAM Vitality Center**. Na enkele seconden zal de lift openen. Stap in en ga naar de eerste verdieping. Onze ruimte bevindt zich aan de linkerkant, achter de bruine deur. Kom gerust naar binnen.", "À votre arrivée, passez la grande porte vitrée (toujours ouverte) jusqu'à l'ascenseur. Sonnez chez **BEAM Vitality Center**. L'ascenseur s'ouvre après quelques secondes. Montez au premier étage. Notre espace se trouve à gauche, derrière la porte brune. Entrez librement.", "When you arrive, walk through the large glass door (it is always open) to the elevator. Press the button for **BEAM Vitality Center**. The elevator will open in a few seconds. Step inside and go to the first floor. Our space is on the left, behind the brown door. Please feel free to come in."],
        ["Indien je om een of andere reden de locatie niet kan vinden of niet binnen geraakt, geef ons ajb een belletje op **+32 9 39 12 422**.", "Si, pour une raison ou une autre, vous ne trouvez pas le lieu ou ne parvenez pas à entrer, appelez-nous au **+32 9 39 12 422**.", "If for any reason you can not find the location or can not get inside, please give us a call at **+32 9 39 12 422**."],
      ],
    },
    {
      h3: ["Parkeren", "Stationnement", "Parking"],
      p: [[
        "We hebben twee privéparkeerplaatsen die meestal gereserveerd zijn voor personen met speciale behoeften. Voor bezoekers overdag vragen wij vriendelijk om niet binnen het park te parkeren, maar op de openbare weg naast ons centrum. Dit is gratis. Voor avondsessies is parkeren binnen het terrein toegestaan, aangezien er dan veel meer beschikbare plekken zijn.",
        "Nous disposons de deux places de parking privées, généralement réservées aux personnes ayant des besoins particuliers. En journée, nous demandons aux visiteurs de ne pas se garer dans le parc, mais sur la voie publique à côté de notre centre. C'est gratuit. Pour les séances du soir, le stationnement sur le site est autorisé, car beaucoup plus de places sont alors disponibles.",
        "We have two private parking spaces that are usually reserved for people with special needs. We kindly ask daytime visitors not to park inside the park, but on the public road next to our center. This is free of charge. For evening sessions, parking on the premises is permitted, as there are many more spaces available at that time.",
      ]],
    },
  ]),
  append(chapter(i, c, "connect", [{
    h: ["Verbind **met ons**", "Restons **en contact**", "Connect **with us**"],
    p: [["Abonneer je op onze nieuwsbrief voor updates en verbind met ons op sociale media:", "Abonnez-vous à notre newsletter pour suivre nos actualités et retrouvez-nous sur les réseaux sociaux :", "Subscribe to our newsletter for updates and follow us on social media:"]],
  }]), [para(SOCIAL.flatMap(([name, href], n) => (n ? [" · ", a(name, href)] : [a(name, href)])))]),
];

// ---------------------------------------------------------------------------
// FAQ: the old site's questions and answers, grouped by theme.
// ---------------------------------------------------------------------------

const FAQ_SESSIONS: Qa[] = [
  { q: ["Wat is BEAM?", "Qu'est-ce que BEAM ?", "What is BEAM?"], a: [["BEAM is een vitaliteitscentrum in Sint-Martens-Latem in België dat ontworpen is om – via zorgvuldig vormgegeven ruimtes – regulatie, herstel en duurzame vitaliteit te ondersteunen.", "BEAM est un centre de vitalité à Sint-Martens-Latem, en Belgique, conçu pour soutenir – grâce à des espaces soigneusement aménagés – la régulation, la récupération et une vitalité durable.", "BEAM is a vitality centre in Sint-Martens-Latem, Belgium, designed to support regulation, recovery and sustained energy through a carefully structured environment."]] },
  { q: ["Hoe kan ik een sessie boeken?", "Comment réserver une séance ?", "How can I book a session?"], a: [["Je kan direct reserveren via de website of contact met ons opnemen per e-mail naar welcome@beam.be of telefonisch op het nummer 0469 41 31 11 (tussen 9u30 en 18u30).", "Vous pouvez réserver directement via le site web ou nous contacter par e-mail à welcome@beam.be ou par téléphone au 0469 41 31 11 (entre 9 h 30 et 18 h 30).", "You can book directly via the website or contact us by email at welcome@beam.be or by phone at +32 469 41 31 11 (between 9:30 AM and 6:30 PM)."]] },
  { q: ["Hoe lang duurt een sessie?", "Combien de temps dure une séance ?", "How long is a session?"], a: [["Een standaardsessie duurt 2 uur. Nachtsessies duren 12 uur.", "Une séance standard dure 2 heures. Les séances de nuit durent 12 heures.", "A standard session lasts two hours. Night sessions run for 12 hours."]] },
  {
    q: ["Hoeveel mensen zijn er aanwezig tijdens een sessie?", "Combien de personnes sont présentes pendant une séance ?", "How many people are present during a session?"],
    a: [
      ["Aan de dagsessies kunnen tot 14 personen deelnemen.", "Jusqu'à 14 personnes peuvent participer aux séances de jour.", "Day sessions typically host up to 12–14 people."],
      ["De nachtsessies zijn beperkt tot maximaal 8 personen om het comfort te waarborgen.", "Les séances de nuit sont limitées à 8 personnes au maximum, pour garantir le confort.", "Night sessions are limited to a smaller group to ensure comfort."],
    ],
  },
  {
    q: ["Is het beter om een dag- of een nachtsessie te kiezen?", "Vaut-il mieux choisir une séance de jour ou de nuit ?", "Is it better to choose a day or night session?"],
    a: [
      ["Beide opties maken gebruik van dezelfde ruimte.", "Les deux formules utilisent le même espace.", "Both formats support the same environment."],
      ["Dagsessies zijn toegankelijker voor wie voor het eerst komt.", "Les séances de jour sont plus accessibles pour une première visite.", "Day sessions are more accessible for first-time visitors."],
      ["Nachtsessies bieden de mogelijkheid om langer ononderbroken in de ruimte te zijn terwijl het lichaam in rust is.", "Les séances de nuit permettent de rester plus longtemps sans interruption dans l'espace pendant que le corps se repose.", "Night sessions allow for longer, uninterrupted exposure while the body is at rest."],
    ],
  },
  {
    q: ["Hoe vaak moet ik langskomen?", "À quelle fréquence dois-je venir ?", "How often should I come?"],
    a: [
      ["Dit hangt af van je eigen ritme en behoeften.", "Cela dépend de votre rythme et de vos besoins.", "This depends on your personal rhythm and needs."],
      ["Gewoonlijk hebben mensen meer baat bij een regelmatig bezoek dan bij een eenmalige sessie.", "En général, des visites régulières apportent davantage qu'une séance unique.", "Many people benefit from regular visits over time rather than a single session."],
    ],
  },
  { q: ["Mag ik mijn pakket met anderen delen?", "Puis-je partager mon forfait avec d'autres personnes ?", "Can I share my package with others?"], a: [["Ja, pakketten kunnen met maximaal vijf personen worden gedeeld.", "Oui, les forfaits peuvent être partagés avec cinq personnes au maximum.", "Yes, packages can be shared with up to five people."]] },
  { q: ["Hoe lang blijven de pakketten geldig?", "Combien de temps les forfaits restent-ils valables ?", "How long are packages valid?"], a: [["De pakketten zijn 18 maanden geldig.", "Les forfaits sont valables 18 mois.", "Packages are valid for 18 months."]] },
  { q: ["Kan ik privésessies of de hele ruimte reserveren?", "Puis-je réserver des séances privées ou l'espace entier ?", "Can I book private sessions or the entire space?"], a: [["Ja, privésessies en groepsreservaties zijn beschikbaar op aanvraag.", "Oui, les séances privées et les réservations de groupe sont possibles sur demande.", "Yes, private sessions and group bookings are available on request."]] },
];

const FAQ_PRACTICAL: Qa[] = [
  { q: ["Welke kledij wordt aanbevolen?", "Quelle tenue est recommandée ?", "What should I wear?"], a: [["We raden aan om comfortabele kleding te dragen. Het doel is om het lichaam volledig te laten ontspannen.", "Nous recommandons de porter des vêtements confortables. Le but est de permettre au corps de se détendre complètement.", "Comfortable clothing is recommended. The goal is to allow the body to relax fully."]] },
  { q: ["Hoe bereid ik me op een sessie voor?", "Comment me préparer à une séance ?", "How should I prepare for a session?"], a: [["Kom indien mogelijk uitgerust aan en zorg dat je voldoende drinkt. Er is geen specifieke voorbereiding nodig.", "Arrivez reposé si possible et veillez à boire suffisamment. Aucune préparation particulière n'est nécessaire.", "Arrive rested where possible and stay well hydrated. No specific preparation is required."]] },
  { q: ["Wat doe ik na een sessie?", "Que faire après une séance ?", "What should I do after a session?"], a: [["Neem de tijd voor rust en herstel, en denk eraan een zoutbad te nemen. Voldoende drinken en een rustig tempo aanhouden, kan je ervaring verder ondersteunen.", "Prenez le temps de vous reposer et de récupérer, et pensez à prendre un bain de sel. Boire suffisamment et garder un rythme calme peut prolonger les bienfaits de votre expérience.", "Allow time for rest and recovery. Staying hydrated and maintaining a calm rhythm can support your experience."]] },
  { q: ["Zijn de sessies privé of gedeeld?", "Les séances sont-elles privées ou partagées ?", "Are sessions private or shared?"], a: [["De sessies vinden plaats in een gemeenschappelijke ruimte, behalve bij privésessies, die op aanvraag kunnen worden ingeboekt.", "Les séances ont lieu dans un espace commun, sauf les séances privées, qui peuvent être réservées sur demande.", "Sessions take place in a shared space, except for private bookings."]] },
  { q: ["Mag ik mijn kind meenemen?", "Puis-je venir avec mon enfant ?", "Can I bring my child?"], a: [["Ja, kinderen zijn welkom tijdens de daartoe bestemde sessies op zaterdagen van 13 tot 15 uur. We vragen je vriendelijk om dit vooraf te melden.", "Oui, les enfants sont les bienvenus lors des séances prévues à cet effet, le samedi de 13 h à 15 h. Merci de nous le signaler à l'avance.", "Yes, children are welcome during designated sessions. Please inform us in advance."]] },
  { q: ["Mag ik mijn huisdier meenemen?", "Puis-je venir avec mon animal de compagnie ?", "Can I bring my pet?"], a: [["Huisdieren zijn welkom tijdens de sessies op maandagen van 16 tot 18 uur. We vragen je vriendelijk om vooraf contact met ons op te nemen.", "Les animaux de compagnie sont les bienvenus lors des séances du lundi de 16 h à 18 h. Merci de nous contacter au préalable.", "Pets are welcome during specific time slots. Please contact us beforehand for details."]] },
  { q: ["Is er parkeergelegenheid?", "Y a-t-il un parking ?", "Is there parking available?"], a: [["Ja, er is een beperkt aantal parkeerplaatsen beschikbaar op het terrein. Daarnaast zijn er gratis openbare parkeerplaatsen vlakbij.", "Oui, un nombre limité de places de parking est disponible sur le site. Il y a aussi des places de parking public gratuites à proximité.", "Yes, limited private parking is available, along with free public parking nearby."]] },
  { q: ["Is de ruimte toegankelijk voor mensen met beperkte mobiliteit?", "L'espace est-il accessible aux personnes à mobilité réduite ?", "Is the space accessible for people with reduced mobility?"], a: [["Ja, onze ruimte is rolstoelvriendelijk. We vragen om van tevoren contact met ons op te nemen, zodat we jou zo goed mogelijk van dienst kunnen zijn.", "Oui, notre espace est accessible en fauteuil roulant. Merci de nous contacter à l'avance afin que nous puissions vous accueillir au mieux.", "Yes, our space is wheelchair friendly. Please contact us in advance so we can assist you appropriately."]] },
];

const FAQ_TECH: Qa[] = [
  { q: ["Wat is het Energy Enhancement System™?", "Qu'est-ce que l'Energy Enhancement System™ ?", "What is the Energy Enhancement System™?"], a: [["Het Energy Enhancement System™ is een niet-invasieve technologie die in de BEAM-ruimte is geïntegreerd en die bijdraagt aan de stabiele en coherente omgevingscondities.", "L'Energy Enhancement System™ est une technologie non invasive intégrée à l'espace BEAM, qui contribue à des conditions ambiantes stables et cohérentes.", "The Energy Enhancement System™ is a non-invasive, energy-based technology integrated into the BEAM environment to support stable and coherent conditions."]] },
  { q: ["Hoe werkt het?", "Comment fonctionne-t-il ?", "How does the system work?"], a: [["Het systeem bestaat uit verscheidene gesynchroniseerde units die in een nauwkeurige ruimtelijke geometrie staan opgesteld. Samen genereren ze gestructureerde lichtpatronen en harmonische signaalinteracties die bijdragen aan stabiele omgevingscondities.", "Le système se compose de plusieurs unités synchronisées, disposées selon une géométrie spatiale précise. Ensemble, elles génèrent des motifs lumineux structurés et des interactions de signaux harmoniques qui contribuent à des conditions ambiantes stables.", "The system consists of multiple synchronized units arranged in precise spatial geometry. Together, they generate structured light patterns and harmonic signal interactions that contribute to consistent environmental conditions."]] },
  { q: ["Hoeveel units zijn er bij BEAM geïnstalleerd?", "Combien d'unités sont installées chez BEAM ?", "How many units are installed at BEAM?"], a: [["BEAM werkt met een configuratie van 48 units en is daarmee een van de grootste coherente EESystem-omgevingen in Europa.", "BEAM fonctionne avec une configuration de 48 unités, ce qui en fait l'un des plus grands environnements EESystem cohérents d'Europe.", "BEAM operates a 48-unit system, forming one of the largest coherent EESystem environments in Europe."]] },
  { q: ["Wat is het verschil tussen een systeem met 12, 24 en 48 units?", "Quelle est la différence entre un système de 12, 24 et 48 unités ?", "What is the difference between a 12-unit, 24-unit and a 48-unit system?"], a: [["Grotere systemen zorgen voor meer ruimtelijke coherentie en een gelijkmatiger lichtverdeling in de hele ruimte, waardoor het veld krachtiger wordt.", "Les systèmes plus grands offrent une plus grande cohérence spatiale et une répartition plus homogène de la lumière dans tout l'espace, ce qui rend le champ plus puissant.", "Larger systems allow for greater spatial consistency and a more uniform environment throughout the room."]] },
  { q: ["Is het EESystem™ veilig?", "L'EESystem™ est-il sûr ?", "Is the EESystem™ safe?"], a: [["Het systeem is niet-invasief en functioneert als onderdeel van de omgeving. Het grijpt niet rechtstreeks in op het lichaam.", "Le système est non invasif et fonctionne comme une partie de l'environnement. Il n'agit pas directement sur le corps.", "The system is non-invasive and operates as part of the environment. It does not act on the body directly."]] },
  { q: ["Zijn er bijwerkingen?", "Y a-t-il des effets secondaires ?", "Are there any side effects?"], a: [["De ervaringen lopen uiteen. Sommige mensen voelen zich na een sessie ontspannen of juist vermoeider, wat een natuurlijke reactie kan zijn op een verandering van toestand.", "Les expériences varient. Certaines personnes se sentent détendues après une séance, ou au contraire plus fatiguées, ce qui peut être une réaction naturelle à un changement d'état.", "Experiences vary. Some people may feel relaxed or more tired after a session, which can be a natural response to a change in state."]] },
  { q: ["Wat kan ik verwachten tijdens een sessie?", "À quoi puis-je m'attendre pendant une séance ?", "What can I expect to feel during a session?"], a: [["Veel mensen ervaren ontspanning, rust of meer helderheid. Anderen voelen zich gewoon meer op hun gemak.", "Beaucoup de personnes ressentent de la détente, du calme ou davantage de clarté. D'autres se sentent simplement plus à l'aise.", "Many people experience relaxation, calm, or improved clarity. Others may simply feel more at ease."]] },
  {
    q: ["Welke voordelen melden mensen?", "Quels bienfaits les gens rapportent-ils ?", "What benefits do people report?"],
    a: [["Gasten melden consistent:", "Nos hôtes rapportent régulièrement :", "Guests often describe:"]],
    list: [
      ["Diepere ontspanning", "Une détente plus profonde", "Deeper relaxation"],
      ["Betere slaap", "Un meilleur sommeil", "Improved sleep"],
      ["Meer helderheid en focus", "Plus de clarté et de concentration", "Greater clarity and focus"],
      ["Minder stress", "Moins de stress", "Reduced stress"],
      ["Een stabieler energieniveau", "Un niveau d'énergie plus stable", "A more stable level of energy"],
    ],
  },
  { q: ["Is er wetenschappelijk onderzoek dat deze aanpak ondersteunt?", "Existe-t-il des recherches scientifiques qui soutiennent cette approche ?", "Is there scientific research supporting this approach?"], a: [["De BEAM-ruimte is gebaseerd op onderzoek in biofysica, systeemwetenschap, neurowetenschap en bio-elektrische regulatie. Voor wie dit verder wil verkennen, is er uitgebreide wetenschappelijke toelichting beschikbaar.", "L'espace BEAM s'appuie sur des recherches en biophysique, en science des systèmes, en neurosciences et en régulation bioélectrique. Pour celles et ceux qui souhaitent approfondir, une documentation scientifique détaillée est disponible.", "The BEAM environment is informed by research in biophysics, systems science, neuroscience and bioelectric regulation. A detailed scientific brief is available for those who wish to explore this further."]] },
  { q: ["Is dit een vervanging voor medische behandeling?", "Est-ce un substitut à un traitement médical ?", "Is this a replacement for medical treatment?"], a: [["Nee, BEAM stelt geen diagnoses, behandelt niet en vervangt geen medische zorg.", "Non, BEAM ne pose pas de diagnostic, ne traite pas et ne remplace pas les soins médicaux.", "No. BEAM does not diagnose, treat or replace medical care."]] },
  { q: ["Moet ik erin geloven om ervoor te zorgen dat het werkt?", "Faut-il y croire pour que cela fonctionne ?", "Do I need to believe in it for it to work?"], a: [["Nee, de omgeving functioneert onafhankelijk van persoonlijke overtuigingen.", "Non, l'environnement fonctionne indépendamment des convictions personnelles.", "No. The environment functions independently of personal belief."]] },
];

const FAQ_PAGE: Builder = (i, c) => [
  faqGroup(i, c, "sessions", ["BEAM & sessies", "BEAM & séances", "BEAM & sessions"], FAQ_SESSIONS),
  faqGroup(i, c, "practical", ["Praktische informatie", "Informations pratiques", "Practical information"], FAQ_PRACTICAL),
  faqGroup(i, c, "tech", ["De technologie", "La technologie", "The technology"], FAQ_TECH),
  book(i, c, "book-day", L_DAY, { kind: "book_day" }, DAY_NOTE),
  book(i, c, "book-night", L_NIGHT, { kind: "book_night" }, NIGHT_NOTE),
  book(i, c, "book-gift", L_GIFT, { kind: "gift" }, GIFT_NOTE),
  cta(i, c, "cta", ["Heb je niet gevonden wat je zocht?", "Vous n'avez pas trouvé ce que vous cherchiez ?", "Did not find what you were looking for?"], ["Neem gerust contact met ons op, we helpen je graag verder.", "N'hésitez pas à nous contacter, nous vous aiderons volontiers.", "Feel free to contact us — we are happy to assist you."], CONTACT_L, c.page("contact")),
];

export const PAGES: Record<string, PageModule> = {
  events: {
    build: EVENTS,
    media: {
      "visit-events-hero": { file: "Events-background-1600400.webp", alt: ["Een volle zaal luistert naar een spreekster tijdens een BEAM-event", "Une salle comble écoute une intervenante lors d'un événement BEAM", "A full room listening to a speaker at a BEAM event"] },
      "visit-praful": { file: "Een-zorgvuldig-samengestelde-3-artist-photos-640x320-webp-1.webp", alt: ["Praful speelt saxofoon tijdens een liveconcert", "Praful joue du saxophone lors d'un concert live", "Praful playing the saxophone at a live concert"] },
      "visit-mercks": { file: "Een-zorgvuldig-samengestelde-3-artist-photos-640x320-webp-2.webp", alt: ["Alexander Mercks met zijn handpan in een zonnige weide", "Alexander Mercks avec son handpan dans une prairie ensoleillée", "Alexander Mercks with his handpan in a sunlit meadow"] },
      "visit-amber": { file: "Een-stem-die-480x500-webpp.webp", alt: ["Amber Haddad met haar muzikanten, met oud en contrabas, in het bos", "Amber Haddad et ses musiciens, avec oud et contrebasse, en forêt", "Amber Haddad with her musicians, oud and double bass, in the woods"] },
    },
  },
  experiences: { build: EXPERIENCES },
  contact: { build: CONTACT },
  faq: { build: FAQ_PAGE },
};
