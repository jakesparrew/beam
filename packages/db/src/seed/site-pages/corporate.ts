/**
 * Site pages of the "corporate" group (see ./index.ts): the corporate page (beam.be/bedrijven and
 * /en/corporates, nl and en verbatim, fr translated) and its three formats, new pages from
 * beam.be/corporate-reset-day, /corporate-venue and /discovery-experience (nl verbatim, fr and en
 * translated: the old site had them in Dutch only). `corporate.coverage.test.ts` fails when a line
 * of the old pages goes missing. Old "Vraag een gesprek aan" buttons (Calendly) lead to the contact page.
 */
import type { Block } from "@beam/core/site";
import { chapter, cards, cta, hero, iconCards, imageText, rt, statement, type BuildCtx, type L3, type MediaSeed, type PageModule } from "../site-kit";

const REQUEST: L3 = ["Vraag een gesprek aan", "Demander un entretien", "Request a call"];
const contactCta = (i: number, c: BuildCtx, heading: L3, body: L3, key = "cta"): Block => cta(i, c, key, heading, body, REQUEST, c.page("contact"));

const media: Record<string, MediaSeed> = {
  "corporate-teams": { file: "Geef-je-team-bg-1600x800-webp.webp", alt: ["Een team in gesprek op meditatiekussens in de BEAM-ruimte", "Une équipe en discussion sur des coussins de méditation dans l'espace BEAM", "A team talking on meditation cushions in the BEAM space"] },
  "corporate-meaning": { file: "Wat-dit-betekent-600x400-1.webp", alt: ["Collega's overleggen samen aan een tafel vol notities", "Des collègues se concertent autour d'une table couverte de notes", "Colleagues working together at a table full of notes"] },
  "corporate-interventions": { file: "De-meeste-interventies-600x400-1.webp", alt: ["Gasten praten na aan de tafel van BEAM", "Des hôtes échangent autour de la table de BEAM", "Guests talking at the table at BEAM"] },
  "corporate-use-cases": { file: "Toepassingsgebieden-600x400-1.webp", alt: ["De BEAM-ruimte met bedden, zetels en meditatiekussens", "L'espace BEAM avec ses lits, fauteuils et coussins de méditation", "The BEAM space with beds, armchairs and meditation cushions"] },
  "corporate-founders": { file: "Een-andere-manier-600x400-1.webp", alt: ["De drie oprichters van BEAM in de ruimte", "Les trois fondateurs de BEAM dans l'espace", "The three founders of BEAM in the space"] },
  "corporate-reset-banner": { file: "Corporate-Reset-Banner-1600x400-webp-scaled.webp", alt: ["Deelnemers rusten in zetels terwijl een groep mediteert in de BEAM-ruimte", "Des participants se reposent dans des fauteuils pendant qu'un groupe médite dans l'espace BEAM", "Participants resting in armchairs while a group meditates in the BEAM space"] },
  "corporate-reset-marina": { file: "corporate-reset-day-1.webp", alt: ["Marina Riemslagh (PhD) van Live The Connection geeft een lezing", "Marina Riemslagh (PhD) de Live The Connection donne une conférence", "Marina Riemslagh (PhD) of Live The Connection giving a talk"] },
  "corporate-reset-founders": { file: "corporate-reset-day-2.webp", alt: ["Jonathan, Sanne en Christophe, de oprichters van BEAM", "Jonathan, Sanne et Christophe, les fondateurs de BEAM", "Jonathan, Sanne and Christophe, the founders of BEAM"] },
  "corporate-reset-space": { file: "corporate-reset-day-3.webp", alt: ["Gasten rusten in de EESystem-omgeving van BEAM", "Des hôtes se reposent dans l'environnement EESystem de BEAM", "Guests resting in BEAM's EESystem environment"] },
  "corporate-reset-welcome": { file: "Persoonlijke-ontvangst-bij-BEAM.webp", alt: ["Collega's drinken koffie bij de ontvangst met ontbijt bij BEAM", "Des collègues prennent un café lors de l'accueil avec petit-déjeuner chez BEAM", "Colleagues having coffee at the breakfast welcome at BEAM"] },
  "corporate-venue-hero": { file: "Hero-image-1920x1000-no-overlay.webp", alt: ["De BEAM-ruimte met zetels, bedden en meditatiekussens bij daglicht", "L'espace BEAM avec fauteuils, lits et coussins de méditation à la lumière du jour", "The BEAM space with armchairs, beds and meditation cushions in daylight"] },
  "corporate-venue-teamdays": { file: "Teamdagen-600x450-webp.webp", alt: ["De ruime BEAM-locatie in de ochtendzon", "Le vaste lieu BEAM dans le soleil du matin", "The spacious BEAM venue in the morning sun"] },
  "corporate-venue-leadership": { file: "Leadership-600x450-webp.webp", alt: ["Een groep staat samen in de BEAM-ruimte", "Un groupe réuni dans l'espace BEAM", "A group standing together in the BEAM space"] },
  "corporate-venue-keynotes": { file: "Keynotes-600x450-webp.webp", alt: ["Een spreker geeft een presentatie bij BEAM", "Un intervenant donne une présentation chez BEAM", "A speaker giving a presentation at BEAM"] },
  "corporate-venue-hr": { file: "HR-600x450-webp.webp", alt: ["Deelnemers mediteren in zetels voor de EESystem-schermen", "Des participants méditent dans des fauteuils devant les écrans EESystem", "Participants meditating in armchairs in front of the EESystem screens"] },
  "corporate-venue-clients": { file: "Exclusieve-klanten-600x450-webp.webp", alt: ["Zakenrelaties in gesprek op kussens in de BEAM-ruimte", "Des relations d'affaires discutent sur des coussins dans l'espace BEAM", "Business guests in conversation on cushions in the BEAM space"] },
  "corporate-discovery-banner": { file: "discovery-experience-Banner-1600x400-webp.webp", alt: ["Een begeleidster leidt een team in meditatie in de BEAM-ruimte", "Une animatrice guide une équipe en méditation dans l'espace BEAM", "A facilitator guiding a team in meditation in the BEAM space"] },
  "corporate-discovery-welcome": { file: "Een-persoonlijk-600x450-webp.webp", alt: ["Gezonde hapjes en fruit bij het onthaal van BEAM", "Des en-cas sains et des fruits à l'accueil de BEAM", "Healthy snacks and fruit at the BEAM welcome"] },
  "corporate-discovery-talk": { file: "Menselijke-energie-600x450-webp.webp", alt: ["De oprichters van BEAM geven een presentatie voor een groep", "Les fondateurs de BEAM présentent devant un groupe", "The founders of BEAM giving a presentation to a group"] },
  "corporate-discovery-reflection": { file: "Reflectie-en-600x450-webp.webp", alt: ["Deelnemers delen hun ervaringen in de zithoek van BEAM", "Des participants partagent leurs expériences dans le coin salon de BEAM", "Participants sharing their experiences in the BEAM lounge"] },
};

// ---------------------------------------------------------------------------
// Voor bedrijven (beam.be/bedrijven, /en/corporates)
// ---------------------------------------------------------------------------

const CORPORATE = (i: number, c: BuildCtx): Block[] => [
  hero(i, c, ["Menselijke energie is de ontbrekende pijler van duurzame prestaties.", "L'énergie humaine est le pilier manquant de la performance durable.", "Human energy is the missing pillar of sustainable performance."], [
    "Voor organisaties: ontdek een andere benadering van welzijn op het werk.",
    "Pour les organisations : découvrez une autre approche du bien-être au travail.",
    "For organisations: discover a different approach to wellbeing at work.",
  ], { label: REQUEST, link: c.page("contact") }, "corporate-teams"),
  imageText(i, c, "limits", "corporate", "right", [{
    h: ["Moderne organisaties **bereiken hun grenzen**.", "Les organisations modernes **atteignent leurs limites**.", "Modern organisations are **reaching their limits**."],
    p: [
      ["De prestatiedruk neemt toe, terwijl de capaciteit om te herstellen afneemt.", "La pression sur la performance augmente, tandis que la capacité de récupération diminue.", "Performance expectations are rising, while recovery capacity is declining."],
      ["Wat steeds duidelijker zichtbaar wordt binnen organisaties, is geen gebrek aan inzet, maar een groeiende kloof in menselijk vermogen.", "Ce qui devient de plus en plus visible au sein des organisations, ce n'est pas un manque d'engagement, mais un écart croissant de capacité humaine.", "What is increasingly visible across organisations is not a lack of effort, but a growing gap in capacity."],
    ],
  }]),
  chapter(i, c, "reality", [{
    h: ["Menselijke energie staat **structureel onder druk**. Bestaande werkmodellen zijn **ontoereikend** om deze trend te keren.", "L'énergie humaine est **structurellement sous pression**. Les modèles de travail actuels sont **insuffisants** pour inverser la tendance.", "Human energy is **under pressure**. Current models are **not reversing** the trend."],
    h3: ["De realiteit waarmee leidinggevenden worden geconfronteerd", "La réalité à laquelle les dirigeants sont confrontés", "The reality leaders are facing"],
    p: [
      ["Binnen organisaties tekent zich een duidelijk patroon af:", "Au sein des organisations, une tendance claire se dessine :", "Across organisations, a clear pattern is emerging:"],
      ["Bronnen: SD Worx · RIZIV/INAMI · Eurofound", "Sources : SD Worx · INAMI/RIZIV · Eurofound", "Sources: SD Worx · RIZIV/INAMI · Eurofound"],
    ],
  }]),
  cards(i, c, "figures", null, [
    { h: ["38%", "38 %", "38%"], t: ["van de gevallen van langdurige arbeidsongeschiktheid in België houdt verband met burn-out, depressie en verwante aandoeningen", "des cas d'incapacité de travail de longue durée en Belgique sont liés au burn-out, à la dépression et à des troubles apparentés", "of long-term disability cases in Belgium are linked to burnout, depression and related conditions"] },
    { h: ["46%", "46 %", "46%"], t: ["van de werknemers rapporteert ernstige tijds- of een te hoge werkdruk", "des travailleurs font état d'une forte pression temporelle ou d'une charge de travail trop élevée", "of employees report severe time pressure or workload"] },
    { h: ["1 op de 12 werknemers", "1 travailleur sur 12", "1 in 12 employees"], t: ["Op een normale werkdag is gemiddeld meer dan 1 op de 12 werknemers afwezig", "Un jour de travail normal, plus d'un travailleur sur 12 est absent en moyenne", "More than 1 in 12 employees are absent on an average working day"] },
  ]),
  statement(i, c, "statement-investment", [
    ["Er wordt meer dan ooit geïnvesteerd in welzijn op de werkvloer.", "Jamais on n'a autant investi dans le bien-être au travail.", "At the same time, investment in wellbeing has never been higher."],
    ["**De resultaten verbeteren echter niet**.", "**Pourtant, les résultats ne s'améliorent pas.**", "**Yet outcomes are not improving.**"],
  ]),
  imageText(i, c, "meaning", "corporate-meaning", "left", [{
    h: ["**Wat dit betekent**", "**Ce que cela signifie**", "**What this means**"],
    p: [
      ["Dit is geen motivatieprobleem. Het is geen gebrek aan inzet en betrokkenheid.", "Ce n'est pas un problème de motivation. Ce n'est pas un manque d'engagement et d'implication.", "This is not a motivation problem. It is not a commitment problem."],
      ["**Het is een capaciteitsprobleem.**", "**C'est un problème de capacité.**", "**It is a capacity problem.**"],
      ["**Het is niet het leiderschap dat faalt. Het is een structurele kloof.**", "**Ce n'est pas le leadership qui échoue. C'est un écart structurel.**", "**It is not leadership that is failing. It is a structural gap.**"],
    ],
  }]),
  imageText(i, c, "overlooked", "corporate-interventions", "right", [{
    h: ["De meeste interventies richten zich op **gedrag, mentaliteit** of **resultaten**.", "La plupart des interventions se concentrent sur le **comportement, l'état d'esprit** ou les **résultats**.", "Most interventions focus on **behaviour, mindset** or **output**."],
    h3: ["Wat vaak over het hoofd wordt gezien", "Ce que l'on néglige souvent", "What is often overlooked"],
    p: [
      ["Wat zelden structureel wordt aangepakt is wat daaraan voorafgaat: **menselijke energie zelf**.", "Ce qui est rarement abordé de manière structurelle, c'est ce qui les précède : **l'énergie humaine elle-même**.", "Very few address what comes before them: **human energy itself**."],
      ["Wanneer de energie uitgeput raakt, moeten alle andere onderdelen harder werken om de prestaties op peil te houden.", "Lorsque l'énergie s'épuise, tous les autres rouages doivent travailler davantage pour maintenir la performance.", "When energy is depleted, every system must work harder to maintain performance."],
      ["Wanneer de energie is hersteld, stabiliseert de regulatie en keren capaciteit en vitaliteit vanzelf terug.", "Lorsque l'énergie est restaurée, la régulation se stabilise et la capacité et la vitalité reviennent d'elles-mêmes.", "When energy is restored, regulation stabilises and capacity returns naturally."],
    ],
  }]),
  chapter(i, c, "approach", [{
    h: ["BEAM werkt op **het niveau waar capaciteit ontstaat**.", "BEAM agit **au niveau où naît la capacité**.", "BEAM **operates** at the level where **capacity begins**."],
    h3: ["De aanpak van BEAM", "L'approche de BEAM", "BEAM’s approach"],
    p: [[
      "Wij bieden geen programma’s, trainingen of gedragsinterventies. Wij creëren een omgeving die is ontworpen om **zelfregulatie, herstel** en **blijvende vitaliteit** te ondersteunen. Hierdoor functioneren individuen en teams vanuit een stabielere en coherente toestand.",
      "Nous ne proposons ni programmes, ni formations, ni interventions comportementales. Nous créons un environnement conçu pour soutenir l'**autorégulation, la récupération** et une **vitalité durable**. Les individus et les équipes fonctionnent ainsi à partir d'un état plus stable et plus cohérent.",
      "We do not introduce programmes, training or behavioural interventions. We provide an environment designed to support **regulation, recovery** and **sustained vitality**. This allows individuals and teams to function from a more stable and coherent state.",
    ]],
  }]),
  chapter(i, c, "outcomes", [{
    h: ["**Wat dit oplevert**", "**Ce que cela permet**", "**What this enables**"],
    p: [
      ["Deze verschuivingen ontstaan niet door extra inspanning maar omdat de omgeving bij BEAM de **juiste condities** schept waarin mensen van nature beter functioneren.", "Ces changements ne naissent pas d'un effort supplémentaire, mais du fait que l'environnement de BEAM crée les **bonnes conditions** dans lesquelles les gens fonctionnent naturellement mieux.", "These shifts do not arise from extra effort, but because the environment at BEAM creates the **right conditions** in which people naturally function better."],
      ["Organisaties die met BEAM samenwerken, merken vaak:", "Les organisations qui travaillent avec BEAM constatent souvent :", "Organisations working with BEAM often observe:"],
    ],
    list: [
      ["Meer helderheid en focus", "Plus de clarté et de concentration", "Greater clarity and focus"],
      ["Beter herstel bij aanhoudende druk", "Une meilleure récupération sous une pression prolongée", "Improved recovery under sustained pressure"],
      ["Stabielere energieniveaus binnen de teams", "Des niveaux d'énergie plus stables au sein des équipes", "More stable energy levels across teams"],
      ["Minder systemische belasting", "Moins de tension systémique", "Reduced systemic strain"],
    ],
  }]),
  rt(i, c, "how", [{
    h: ["Hoe **organisaties** met BEAM werken", "Comment les **organisations** travaillent avec BEAM", "How **organisations** work with BEAM"],
    p: [["Wij bieden flexibele opties aan, afgestemd op de behoeften:", "Nous proposons des formules flexibles, adaptées à vos besoins :", "We offer flexible formats depending on your needs:"]],
  }]),
  cards(i, c, "options", null, [
    { h: ["Individuele sessies", "Séances individuelles", "Individual sessions"], t: ["Voor leidinggevenden of sleutelpersonen die op zoek zijn naar herstel en helderheid", "Pour les dirigeants ou les personnes clés en quête de récupération et de clarté", "For leaders or key team members seeking recovery and clarity"] },
    { h: ["Groepsessies", "Séances de groupe", "Team sessions"], t: ["Gedeelde ervaringen die collectieve regulatie ondersteunen", "Des expériences partagées qui soutiennent la régulation collective", "Shared experiences designed to support collective regulation"] },
    { h: ["Bedrijfsevenementen", "Événements d'entreprise", "Corporate events"], t: ["Ontbijtsessies, besloten bijeenkomsten of zorgvuldig samengestelde ervaringen bij BEAM", "Séances petit-déjeuner, rencontres privées ou expériences soigneusement composées chez BEAM", "Breakfast sessions, private gatherings or curated experiences at BEAM"] },
    { h: ["Structurele samenwerking", "Partenariat structurel", "Long-term partnerships"], t: ["Een gestructureerde integratie van BEAM binnen de strategie van de organisatie rondom menselijke energie", "Une intégration structurée de BEAM dans la stratégie de l'organisation en matière d'énergie humaine", "Structured integration of BEAM as part of your organisation’s approach to human energy"] },
    { h: ["Pilootprojecten", "Projets pilotes", "Pilot projects"], t: ["Een begeleid instaptraject voor organisaties die BEAM willen ervaren voordat ze een structurele samenwerking aangaan.", "Un parcours d'entrée accompagné pour les organisations qui souhaitent découvrir BEAM avant de s'engager dans un partenariat structurel.", "A guided onboarding program for organizations that want to experience BEAM before entering into a long-term partnership."] },
  ], "list"),
  imageText(i, c, "use-cases", "corporate-use-cases", "left", [{
    h: ["**Toepassingsgebieden**", "**Domaines d'application**", "**Use cases**"],
    p: [["BEAM is relevant voor organisaties die te maken hebben met:", "BEAM s'adresse aux organisations confrontées à :", "BEAM is relevant for organisations facing:"]],
    list: [
      ["**Aanhoudende cognitieve belasting**", "**Une charge cognitive prolongée**", "**Sustained cognitive load**"],
      ["**High performance omgevingen**", "**Des environnements à haute performance**", "**High-performance environments**"],
      ["**Leiderschapsmoeheid**", "**La fatigue des dirigeants**", "**Leadership fatigue**"],
      ["**Uitdagingen bij herstel**", "**Des défis de récupération**", "**Recovery challenges**"],
      ["**Preventie van burn-out en re-integratie**", "**La prévention du burn-out et la réintégration**", "**Burnout prevention and reintegration**"],
    ],
  }]),
  imageText(i, c, "different", "corporate-founders", "right", [{
    h: ["Een **andere** manier van denken", "Une **autre** façon de penser", "A **different** way of thinking"],
    p: [["BEAM grijpt niet in op mensen maar creëert een omgeving waar mensen tot rust kunnen komen en herstellen om opnieuw optimaal te kunnen functioneren.", "BEAM n'agit pas sur les personnes, mais crée un environnement où chacun peut se poser et récupérer pour fonctionner à nouveau de manière optimale.", "BEAM does not act on people. It shapes the environment in which people function."]],
  }]),
  statement(i, c, "statement-system", [["**Zodra de omgeving zich stabiliseert, volgt het systeem vanzelf.**", "**Dès que l'environnement se stabilise, le système suit de lui-même.**", "**When the environment stabilises, the system follows.**"]]),
  cards(i, c, "formats", ["Ontdek ons aanbod voor bedrijven", "Découvrez notre offre pour les entreprises", "Discover our offer for organisations"], [
    {
      h: ["BEAM Discovery Experience", "BEAM Discovery Experience", "BEAM Discovery Experience"],
      t: [
        "Een toegankelijke inleiding tot energie, stress en herstel. Een ervaring van een halve dag (3,5 uur) voor minimaal 6 personen, ideaal voor teams die welzijn, herstel en duurzame prestaties van hun medewerkers willen verbeteren.",
        "Une introduction accessible à l'énergie, au stress et à la récupération. Une expérience d'une demi-journée (3,5 heures) dès 6 personnes, idéale pour les équipes qui veulent améliorer le bien-être, la récupération et la performance durable de leurs collaborateurs.",
        "An accessible introduction to energy, stress and recovery. A half-day experience (3.5 hours) for at least 6 people, ideal for teams that want to improve their employees' wellbeing, recovery and sustainable performance.",
      ],
      link: c.page("discovery-experience"),
      img: "corporate-discovery-reflection",
    },
    {
      h: ["Corporate Reset Day", "Corporate Reset Day", "Corporate Reset Day"],
      t: [
        "Een begeleid programma dat deskundige inzichten, teamactiviteiten en diepe ontspanning combineert. Een volledig programma (5 uur) voor minimaal 6 personen, ideaal voor teams die op zoek zijn naar een grondige reset en hernieuwde focus.",
        "Un programme accompagné qui associe l'éclairage d'experts, des activités d'équipe et une relaxation profonde. Un programme complet (5 heures) dès 6 personnes, idéal pour les équipes en quête d'une véritable remise à zéro et d'une concentration retrouvée.",
        "A guided programme combining expert insights, team activities and deep relaxation. A full programme (5 hours) for at least 6 people, ideal for teams looking for a thorough reset and renewed focus.",
      ],
      link: c.page("corporate-reset-day"),
      img: "corporate-reset-marina",
    },
    {
      h: ["BEAM Corporate Venue", "BEAM Corporate Venue", "BEAM Corporate Venue"],
      t: [
        "Een unieke en exclusieve locatie voor vergaderingen, presentaties en zakelijke evenementen. Veelzijdig inzetbaar, voor maximaal 125 personen en op maat van uw behoeften, met optionele welzijnsactiviteiten.",
        "Un lieu unique et exclusif pour vos réunions, présentations et événements professionnels. Polyvalent, jusqu'à 125 personnes et adapté à vos besoins, avec des activités bien-être en option.",
        "A unique and exclusive venue for meetings, presentations and business events. Versatile, for up to 125 people and tailored to your needs, with optional wellbeing activities.",
      ],
      link: c.page("corporate-venue"),
      img: "corporate-venue-keynotes",
    },
  ]),
  contactCta(i, c, ["Benieuwd wat BEAM voor uw organisatie kan betekenen?", "Envie de savoir ce que BEAM peut apporter à votre organisation ?", "Curious what BEAM can do for your organisation?"], [
    "Plan een vrijblijvend kennismakingsgesprek. Samen bekijken we welke vorm het best aansluit bij uw teams en doelstellingen.",
    "Planifiez un premier entretien sans engagement. Ensemble, nous verrons quelle formule convient le mieux à vos équipes et à vos objectifs.",
    "Plan a no-obligation intro call. Together we look at which format best fits your teams and goals.",
  ]),
];

// ---------------------------------------------------------------------------
// Shared by the Corporate Reset Day and the Discovery Experience
// ---------------------------------------------------------------------------

const investment = (i: number, c: BuildCtx): Block =>
  statement(i, c, "statement-investment", [["Een zinvolle investering in uw **medewerkers**", "Un investissement porteur de sens pour vos **collaborateurs**", "A meaningful investment in your **employees**"]]);

const nextSteps = (i: number, c: BuildCtx): Block =>
  chapter(i, c, "next-steps", [{
    h: ["Mogelijke vervolgstappen", "Suites possibles", "Possible next steps"],
    p: [["Voor organisaties die dit wensen, kan deze ervaring later uitgebreid worden naar:", "Pour les organisations qui le souhaitent, cette expérience peut ensuite être prolongée par :", "For organisations that wish to, this experience can later be extended to:"]],
    list: [
      ["Pilootprojecten", "Des projets pilotes", "Pilot projects"],
      ["Individuele BEAM-trajecten voor medewerkers", "Des parcours BEAM individuels pour les collaborateurs", "Individual BEAM programmes for employees"],
      ["Leadership Reset Days", "Des Leadership Reset Days", "Leadership Reset Days"],
      ["Langdurige welzijns- en energieprogramma’s", "Des programmes de bien-être et d'énergie à long terme", "Long-term wellbeing and energy programmes"],
      ["Lezingen of introducties op locatie", "Des conférences ou des introductions sur site", "Talks or introductions on location"],
    ],
  }]);

const WHY: L3 = ["Waarom deze ervaring?", "Pourquoi cette expérience ?", "Why this experience?"];

// ---------------------------------------------------------------------------
// Corporate Reset Day (beam.be/corporate-reset-day, Dutch only on the old site)
// ---------------------------------------------------------------------------

const RESET_DAY = (i: number, c: BuildCtx): Block[] => [
  hero(i, c, ["Corporate Reset Day", "Corporate Reset Day", "Corporate Reset Day"], [
    "Een verrijkende ervaring waarin stressbeheersing, herstel en menselijke energie centraal staan.",
    "Une expérience enrichissante centrée sur la gestion du stress, la récupération et l'énergie humaine.",
    "An enriching experience centred on stress management, recovery and human energy.",
  ], { label: REQUEST, link: c.page("contact") }, "corporate-reset-banner"),
  chapter(i, c, "why", [{
    h: WHY,
    p: [
      ["Stress stapelt zich op, focus vermindert, energie zakt weg en het zenuwstelsel blijft voortdurend “aan” staan.", "Le stress s'accumule, la concentration diminue, l'énergie s'effondre et le système nerveux reste constamment « allumé ».", "Stress builds up, focus fades, energy drains away and the nervous system stays switched “on” all the time."],
      ["Vaak blijven deze signalen lange tijd onder de radar, tot ze zich beginnen te vertalen in uitputting, spanningen, verminderde betrokkenheid of langdurige afwezigheid.", "Souvent, ces signaux passent longtemps inaperçus, jusqu'à ce qu'ils se traduisent par de l'épuisement, des tensions, un engagement en baisse ou des absences de longue durée.", "These signals often stay under the radar for a long time, until they start to show up as exhaustion, tension, reduced engagement or long-term absence."],
      ["De **Corporate Reset Day** werd ontwikkeld als een krachtig en verbindend ervaringsmoment waarin medewerkers opnieuw kunnen vertragen, opladen en verbinding maken met hun energie, lichaam en mentale helderheid.", "La **Corporate Reset Day** a été conçue comme un moment fort et fédérateur, où les collaborateurs peuvent à nouveau ralentir, se ressourcer et renouer avec leur énergie, leur corps et leur clarté mentale.", "The **Corporate Reset Day** was developed as a powerful, connecting experience in which employees can slow down again, recharge and reconnect with their energy, their body and their mental clarity."],
    ],
  }]),
  rt(i, c, "unique", [{
    h: ["Wat maakt deze dag **uniek**?", "Qu'est-ce qui rend cette journée **unique** ?", "What makes this day **unique**?"],
    p: [["Deze dag brengt drie complementaire elementen samen:", "Cette journée réunit trois éléments complémentaires :", "This day brings together three complementary elements:"]],
  }]),
  cards(i, c, "elements", null, [
    { h: ["Live The Connection — Marina Riemslagh (PhD)", "Live The Connection — Marina Riemslagh (PhD)", "Live The Connection — Marina Riemslagh (PhD)"], t: ["Inzichten en oefeningen rond stress, het zenuwstelsel, onbewuste patronen en emotionele ontkoppeling.", "Des éclairages et des exercices autour du stress, du système nerveux, des schémas inconscients et de la déconnexion émotionnelle.", "Insights and exercises on stress, the nervous system, unconscious patterns and emotional disconnection."], img: "corporate-reset-marina" },
    { h: ["BEAM — Jonathan, Sanne & Christophe", "BEAM — Jonathan, Sanne & Christophe", "BEAM — Jonathan, Sanne & Christophe"], t: ["Een heldere introductie rond menselijke energie, herstelcapaciteit en de invloed van de omgeving op hoe mensen functioneren.", "Une introduction claire à l'énergie humaine, à la capacité de récupération et à l'influence de l'environnement sur le fonctionnement des personnes.", "A clear introduction to human energy, recovery capacity and how the environment influences the way people function."], link: c.page("founders"), img: "corporate-reset-founders" },
    { h: ["The BEAM Experience", "The BEAM Experience", "The BEAM Experience"], t: ["Twee uur diepe rust binnen de coherente omgeving van het Energy Enhancement System™, waar medewerkers de ruimte zelf kunnen ervaren.", "Deux heures de repos profond dans l'environnement cohérent de l'Energy Enhancement System™, où les collaborateurs peuvent faire eux-mêmes l'expérience de l'espace.", "Two hours of deep rest in the coherent environment of the Energy Enhancement System™, where employees can experience the space for themselves."], link: c.page("technology"), img: "corporate-reset-space" },
  ]),
  investment(i, c),
  cards(i, c, "benefits", ["Wat uw team ermee kan bereiken", "Ce que votre équipe peut en retirer", "What your team can achieve"], [
    { h: ["Stressbeheersing en herstel", "Gestion du stress et récupération", "Stress management and recovery"], t: ["Help je team om stress onder controle te houden, het zenuwstelsel te kalmeren en dieper te herstellen.", "Aidez votre équipe à garder le stress sous contrôle, à apaiser le système nerveux et à récupérer plus profondément.", "Help your team keep stress under control, calm the nervous system and recover more deeply."] },
    { h: ["Hernieuwde focus en duidelijkheid", "Concentration et clarté retrouvées", "Renewed focus and clarity"], t: ["Helderder denken, een betere concentratie en een sterker gevoel van richting en doelgerichtheid.", "Une pensée plus claire, une meilleure concentration et un sens plus fort de la direction et des objectifs.", "Clearer thinking, better concentration and a stronger sense of direction and purpose."] },
    { h: ["Grotere veerkracht", "Une plus grande résilience", "Greater resilience"], t: ["Ontwikkel veerkracht en emotioneel evenwicht om veranderingen en druk gemakkelijker het hoofd te bieden.", "Développez la résilience et l'équilibre émotionnel pour faire face plus facilement au changement et à la pression.", "Build resilience and emotional balance to cope more easily with change and pressure."] },
    { h: ["Duurzame prestaties", "Une performance durable", "Sustainable performance"], t: ["Zorg voor duurzame energie, welzijn en prestaties voor uw medewerkers en uw organisatie.", "Assurez une énergie, un bien-être et une performance durables pour vos collaborateurs et votre organisation.", "Secure lasting energy, wellbeing and performance for your employees and your organisation."] },
  ], "list"),
  imageText(i, c, "included", "corporate-reset-welcome", "right", [{
    h: ["Een begeleid programma, ontworpen om daadwerkelijk effect te sorteren.", "Un programme accompagné, conçu pour produire un effet réel.", "A guided programme, designed to make a real difference."],
    h3: ["Wat is inbegrepen in de Corporate Reset Day?", "Qu'est-ce qui est compris dans la Corporate Reset Day ?", "What is included in the Corporate Reset Day?"],
    list: [
      ["Persoonlijke ontvangst bij BEAM", "Accueil personnalisé chez BEAM", "Personal welcome at BEAM"],
      ["Lezing door Marina Riemslagh", "Conférence de Marina Riemslagh", "Talk by Marina Riemslagh"],
      ["Lezing door Jonathan Bossaer", "Conférence de Jonathan Bossaer", "Talk by Jonathan Bossaer"],
      ["Workshop & praktische integratie", "Atelier & intégration pratique", "Workshop & practical integration"],
      ["Ontbijt, lichte lunch & gezonde snacks", "Petit-déjeuner, lunch léger & collations saines", "Breakfast, light lunch & healthy snacks"],
      ["Vijf uur toegang tot de BEAM-omgeving", "Cinq heures d'accès à l'environnement BEAM", "Five hours of access to the BEAM environment"],
      ["Volledige begeleiding gedurende de dag", "Accompagnement complet tout au long de la journée", "Full guidance throughout the day"],
    ],
  }]),
  rt(i, c, "audience-intro", [{
    h: ["Voor wie is de Corporate Reset Day bedoeld?", "À qui s'adresse la Corporate Reset Day ?", "Who is the Corporate Reset Day for?"],
    p: [["Een verrijkende ervaring voor organisaties.", "Une expérience enrichissante pour les organisations.", "An enriching experience for organisations."]],
  }]),
  iconCards(i, c, "audience", null, [
    { icon: "individuals", h: ["Omgaan met stress en overbelasting op het werk", "Faire face au stress et à la surcharge au travail", "Dealing with stress and overload at work"], t: ["Geef medewerkers de kans om even afstand te nemen van de hoge vereisten, meer inzicht te krijgen in stress en praktische manieren te ontdekken om ermee om te gaan.", "Offrez à vos collaborateurs l'occasion de prendre un peu de recul face aux exigences élevées, de mieux comprendre le stress et de découvrir des façons concrètes d'y faire face.", "Give employees the chance to step back from high demands, gain more insight into stress and discover practical ways to deal with it."] },
    { icon: "professionals", h: ["De betrokkenheid van het team versterken", "Renforcer l'engagement de l'équipe", "Strengthening team engagement"], t: ["Breng collega’s bij elkaar door middel van zinvolle gesprekken en concrete oefeningen die verbinding, begrip en samenwerking bevorderen.", "Rassemblez vos collègues autour d'échanges porteurs de sens et d'exercices concrets qui favorisent le lien, la compréhension et la collaboration.", "Bring colleagues together through meaningful conversations and concrete exercises that foster connection, understanding and collaboration."] },
    { icon: "organisations", h: ["Investeren in het welzijn van je medewerkers", "Investir dans le bien-être de vos collaborateurs", "Investing in your employees' wellbeing"], t: ["Kies voor een meer proactieve aanpak van het welzijn van medewerkers door praktische inzichten aan te reiken over stressbeheersing, herstel en gezondere werkgewoonten.", "Optez pour une approche plus proactive du bien-être de vos collaborateurs en leur apportant des clés concrètes sur la gestion du stress, la récupération et des habitudes de travail plus saines.", "Take a more proactive approach to employee wellbeing by offering practical insights into stress management, recovery and healthier work habits."] },
    { icon: "leaders", h: ["Ondersteuning van leidinggevende teams", "Soutenir les équipes dirigeantes", "Supporting leadership teams"], t: ["Bied leidinggevenden de ruimte om na te denken over hun eigen energie en de gevolgen van aanhoudende druk, en om meer bewustzijn te ontwikkelen over herstel en veerkracht.", "Offrez aux dirigeants l'espace pour réfléchir à leur propre énergie et aux effets d'une pression prolongée, et pour développer une meilleure conscience de la récupération et de la résilience.", "Give leaders room to reflect on their own energy and the effects of sustained pressure, and to build greater awareness of recovery and resilience."] },
  ]),
  nextSteps(i, c),
  contactCta(i, c, ["Niet harder werken. Wel beter opladen.", "Pas travailler plus dur. Mieux se ressourcer.", "Not working harder. Recharging better."], [
    "Een nieuwe start voor blijvende resultaten. Duurzame prestaties ontstaan wanneer mensen opnieuw ruimte krijgen voor rust, helderheid en balans.",
    "Un nouveau départ pour des résultats durables. La performance durable naît lorsque les gens retrouvent de l'espace pour le repos, la clarté et l'équilibre.",
    "A fresh start for lasting results. Sustainable performance emerges when people are given room again for rest, clarity and balance.",
  ]),
];

// ---------------------------------------------------------------------------
// BEAM Corporate Venue (beam.be/corporate-venue, Dutch only on the old site)
// ---------------------------------------------------------------------------

const VENUE = (i: number, c: BuildCtx): Block[] => [
  hero(i, c, ["BEAM Corporate Venue", "BEAM Corporate Venue", "BEAM Corporate Venue"], ["Teambuilding in een unieke omgeving in Vlaanderen.", "Du team building dans un cadre unique en Flandre.", "Team building in a unique setting in Flanders."], { label: REQUEST, link: c.page("contact") }, "corporate-venue-hero"),
  chapter(i, c, "intro", [{
    p: [
      ["BEAM Vitality Center in Sint-Martens-Latem biedt bedrijven een premium locatie voor bijeenkomsten die meer verdienen dan een klassieke vergader- of evenementruimte.", "Le BEAM Vitality Center à Sint-Martens-Latem offre aux entreprises un lieu premium pour des rencontres qui méritent plus qu'une salle de réunion ou d'événement classique.", "BEAM Vitality Center in Sint-Martens-Latem offers companies a premium venue for gatherings that deserve more than a classic meeting or event space."],
      ["Onze zorgvuldig ontworpen omgeving brengt hoogwaardige technologie, natuurlijke elementen, verfijnd comfort en persoonlijke gastvrijheid samen in een sfeer van rust en harmonie.", "Notre environnement soigneusement conçu réunit une technologie de pointe, des éléments naturels, un confort raffiné et une hospitalité personnalisée dans une atmosphère de calme et d'harmonie.", "Our carefully designed environment brings together high-end technology, natural elements, refined comfort and personal hospitality in an atmosphere of calm and harmony."],
      ["Of het nu gaat om een inspirerende teamdag, een strategische managementsessie, een bedrijfspresentatie of een besloten klantenevent: BEAM biedt een unieke setting om samen te komen, nieuwe perspectieven te ontdekken en ruimte te maken voor wat werkelijk belangrijk is.", "Qu'il s'agisse d'une journée d'équipe inspirante, d'une session stratégique de management, d'une présentation d'entreprise ou d'un événement client privé : BEAM offre un cadre unique pour se réunir, découvrir de nouvelles perspectives et faire de la place à ce qui compte vraiment.", "Whether it is an inspiring team day, a strategic management session, a company presentation or a private client event: BEAM offers a unique setting to come together, discover new perspectives and make room for what truly matters."],
    ],
  }]),
  statement(i, c, "statement-combination", [["De krachtige combinatie van **rust, technologie, verbondenheid** en **professionele faciliteiten**", "La puissante combinaison du **calme, de la technologie, du lien** et d'**installations professionnelles**", "The powerful combination of **calm, technology, connection** and **professional facilities**"]]),
  iconCards(i, c, "special", ["Wat maakt BEAM bijzonder?", "Qu'est-ce qui rend BEAM unique ?", "What makes BEAM special?"], [
    { icon: "professionals", h: ["Rust en verbondenheid", "Calme et lien", "Calm and connection"], t: ["Een rustige omgeving die is ontworpen om helderheid, bezinning en betekenisvolle verbindingen te stimuleren.", "Un environnement paisible, conçu pour favoriser la clarté, la réflexion et des liens porteurs de sens.", "A calm environment designed to encourage clarity, reflection and meaningful connections."] },
    { icon: "ees", h: ["Technologie en comfort", "Technologie et confort", "Technology and comfort"], t: ["Ons Energy Enhancement System™ met 48 units, gelegen in een unieke omgeving die is ontworpen voor rust en ontspanning.", "Notre Energy Enhancement System™ de 48 unités, au cœur d'un environnement unique conçu pour le repos et la détente.", "Our 48-unit Energy Enhancement System™, set in a unique environment designed for rest and relaxation."], link: c.page("technology") },
    { icon: "technology", h: ["Professionele faciliteiten", "Des installations professionnelles", "Professional facilities"], t: ["Hoogwaardige audiovisuele apparatuur voor vlekkeloze vergaderingen, presentaties en evenementen.", "Un équipement audiovisuel haut de gamme pour des réunions, présentations et événements sans accroc.", "High-end audiovisual equipment for flawless meetings, presentations and events."] },
    { icon: "individuals", h: ["Persoonlijke gastvrijheid en exclusiviteit", "Hospitalité personnalisée et exclusivité", "Personal hospitality and exclusivity"], t: ["Een warm welkom, persoonlijke service en de mogelijkheid om de locatie exclusief te reserveren.", "Un accueil chaleureux, un service personnalisé et la possibilité de réserver le lieu en exclusivité.", "A warm welcome, personal service and the option to book the venue exclusively."] },
  ]),
  chapter(i, c, "possibilities", [{
    h: ["Een bijzondere locatie voor uw zakelijke bijeenkomsten", "Un lieu d'exception pour vos rencontres professionnelles", "An exceptional venue for your business gatherings"],
    h3: ["De mogelijkheden", "Les possibilités", "The possibilities"],
    p: [["BEAM biedt een veelzijdige omgeving voor organisaties die hun medewerkers, management teams, klanten of zakelijke relaties buiten de gebruikelijke werkomgeving willen samenbrengen.", "BEAM offre un environnement polyvalent aux organisations qui souhaitent réunir leurs collaborateurs, leurs équipes de direction, leurs clients ou leurs relations d'affaires en dehors du cadre de travail habituel.", "BEAM offers a versatile environment for organisations that want to bring their employees, management teams, clients or business relations together outside their usual work setting."]],
  }]),
  cards(i, c, "uses", null, [
    { h: ["Teamdagen & Corporate Offsites", "Journées d'équipe & séminaires d'entreprise", "Team days & corporate offsites"], t: ["Breng collega's samen in een inspirerende setting waar verbinding, samenwerking en nieuwe perspectieven centraal staan. BEAM biedt een aangenaam kader voor teamontwikkeling, inhoudelijke uitwisseling en gezamenlijke reflectie.", "Réunissez vos collègues dans un cadre inspirant où le lien, la collaboration et les nouvelles perspectives sont au cœur de tout. BEAM offre un cadre agréable pour le développement d'équipe, les échanges de fond et la réflexion commune.", "Bring colleagues together in an inspiring setting centred on connection, collaboration and new perspectives. BEAM offers a pleasant framework for team development, in-depth exchange and shared reflection."], img: "corporate-venue-teamdays" },
    { h: ["Keynotes, presentaties & inspiratiesessies", "Keynotes, présentations & sessions d'inspiration", "Keynotes, presentations & inspiration sessions"], t: ["Van inhoudelijke bedrijfspresentaties tot lezingen en interactieve sessies. Onze professionele audiovisuele infrastructuur biedt een kwalitatieve setting voor sprekers en deelnemers.", "Des présentations d'entreprise approfondies aux conférences et sessions interactives. Notre infrastructure audiovisuelle professionnelle offre un cadre de qualité aux intervenants comme aux participants.", "From in-depth company presentations to talks and interactive sessions. Our professional audiovisual infrastructure offers a quality setting for speakers and participants."], img: "corporate-venue-keynotes" },
    { h: ["Exclusieve klanten- & relatie-evenementen", "Événements exclusifs pour clients & relations", "Exclusive client & relationship events"], t: ["Ontvang klanten, partners of een select gezelschap in een warme en onderscheidende setting. BEAM leent zich voor besloten presentaties, inspirerende ontmoetingen en hoogwaardige zakelijke evenementen.", "Recevez vos clients, partenaires ou un cercle restreint d'invités dans un cadre chaleureux et distinctif. BEAM se prête aux présentations privées, aux rencontres inspirantes et aux événements professionnels haut de gamme.", "Welcome clients, partners or a select group in a warm and distinctive setting. BEAM lends itself to private presentations, inspiring encounters and high-end business events."], img: "corporate-venue-clients" },
  ]),
  imageText(i, c, "leadership", "corporate-venue-leadership", "right", [{
    h3: ["Leadership & Management Meetings", "Réunions de direction & de management", "Leadership & management meetings"],
    p: [
      ["Een rustige en exclusieve omgeving voor directies, ondernemers en management teams die bewust afstand willen nemen van de dagelijkse bedrijfsdruk.", "Un environnement calme et exclusif pour les directions, les entrepreneurs et les équipes de management qui veulent prendre consciemment du recul par rapport à la pression quotidienne.", "A calm and exclusive environment for boards, entrepreneurs and management teams who deliberately want to step away from the day-to-day pressure of business."],
      ["BEAM biedt ruimte voor strategisch overleg, belangrijke beslissingen, reflectie en toekomstgerichte gesprekken, met professionele faciliteiten en de nodige discretie.", "BEAM offre l'espace pour la concertation stratégique, les décisions importantes, la réflexion et les échanges tournés vers l'avenir, avec des installations professionnelles et toute la discrétion nécessaire.", "BEAM offers room for strategic consultation, important decisions, reflection and forward-looking conversations, with professional facilities and the necessary discretion."],
      ["Organisaties kunnen hun eigen programma samenstellen of kiezen voor aanvullende begeleiding vanuit BEAM.", "Les organisations peuvent composer leur propre programme ou opter pour un accompagnement complémentaire de BEAM.", "Organisations can put together their own programme or opt for additional guidance from BEAM."],
    ],
  }]),
  imageText(i, c, "hr", "corporate-venue-hr", "left", [{
    h3: ["HR & Wellbeing Events", "Événements RH & bien-être", "HR & wellbeing events"],
    p: [
      ["Een passende omgeving voor organisaties die aandacht willen besteden aan medewerkerswelzijn, veerkracht, werkgeluk en duurzame inzetbaarheid.", "Un cadre adapté aux organisations qui veulent prêter attention au bien-être de leurs collaborateurs, à la résilience, au bonheur au travail et à l'employabilité durable.", "A fitting environment for organisations that want to focus on employee wellbeing, resilience, happiness at work and sustainable employability."],
      ["Ideaal voor inspiratiedagen, thematische bijeenkomsten, teambuilding en initiatieven rond menselijke energie en herstel.", "Idéal pour des journées d'inspiration, des rencontres thématiques, du team building et des initiatives autour de l'énergie humaine et de la récupération.", "Ideal for inspiration days, themed gatherings, team building and initiatives around human energy and recovery."],
    ],
  }]),
  contactCta(i, c, ["Reserveer BEAM exclusief voor uw eigen programma.", "Réservez BEAM en exclusivité pour votre propre programme.", "Book BEAM exclusively for your own programme."], [
    "Uw bijeenkomst, op uw manier. Bedrijven kunnen BEAM exclusief reserveren voor hun eigen zakelijke programma, waarbij zij toegang krijgen tot de beschikbare faciliteiten en horecadiensten zoals overeengekomen.",
    "Votre rencontre, à votre façon. Les entreprises peuvent réserver BEAM en exclusivité pour leur propre programme professionnel, avec accès aux installations disponibles et aux services de restauration convenus.",
    "Your gathering, your way. Companies can book BEAM exclusively for their own business programme, with access to the available facilities and catering services as agreed.",
  ], "reserve"),
  imageText(i, c, "equipment", "corporate-discovery-talk", "right", [
    {
      h: ["Professioneel uitgerust. Zorgvuldig ontworpen.", "Équipé de manière professionnelle. Conçu avec soin.", "Professionally equipped. Carefully designed."],
      h3: ["Infrastructuur & reservaties", "Infrastructure & réservations", "Infrastructure & bookings"],
    },
    {
      h3: ["Presentatie & projectie", "Présentation & projection", "Presentation & projection"],
      list: [
        ["Optoma laserprojector", "Projecteur laser Optoma", "Optoma laser projector"],
        ["Full HD-resolutie (1920 × 1080)", "Résolution Full HD (1920 × 1080)", "Full HD resolution (1920 × 1080)"],
        ["5.000 ANSI lumens", "5 000 ANSI lumens", "5,000 ANSI lumens"],
        ["Projectiescherm van 135 inch (16:9).", "Écran de projection de 135 pouces (16:9).", "135-inch projection screen (16:9)."],
      ],
    },
    { p: [["Een hoogwaardige oplossing voor bedrijfspresentaties, videobeelden, inspiratiesessies en visuele ondersteuning tijdens zakelijke bijeenkomsten.", "Une solution haut de gamme pour les présentations d'entreprise, les vidéos, les sessions d'inspiration et le support visuel lors de vos rencontres professionnelles.", "A high-quality solution for company presentations, video footage, inspiration sessions and visual support during business gatherings."]] },
    {
      h3: ["Professionele geluidsinstallatie", "Installation sonore professionnelle", "Professional sound system"],
      list: [
        ["Yamaha STAGEPAS 1K MKII geluidssysteem", "Système de sonorisation Yamaha STAGEPAS 1K MKII", "Yamaha STAGEPAS 1K MKII sound system"],
        ["Aanvullende actieve luidspreker", "Enceinte active supplémentaire", "Additional active speaker"],
        ["Aangevuld met draadloze Sennheiser-microfoons", "Complété par des microphones sans fil Sennheiser", "Complemented by wireless Sennheiser microphones"],
        ["Draadloze headsetmicrofoon", "Microphone serre-tête sans fil", "Wireless headset microphone"],
        ["Professionele geluidsweergave voor presentaties, lezingen en achtergrondmuziek", "Une restitution sonore professionnelle pour les présentations, les conférences et la musique d'ambiance", "Professional sound for presentations, talks and background music"],
        ["Aansluitingen en technische voorzieningen voor uiteenlopende toepassingen", "Des connexions et équipements techniques pour des usages variés", "Connections and technical provisions for a wide range of uses"],
      ],
    },
  ]),
  rt(i, c, "practical-intro", [{
    h: ["Alles wat u moet weten", "Tout ce que vous devez savoir", "Everything you need to know"],
    h3: ["Praktische informatie", "Informations pratiques", "Practical information"],
  }]),
  // White cards in a row of four, like `iconCards`; these four topics have no matching brand icon.
  {
    id: c.id("practical"),
    type: "card_grid",
    layout: "icons",
    cards: [
      { heading: ["Locatie", "Lieu", "Location"][i]!, text: ["BEAM Vitality Center, Xavier de Cocklaan 70, bus 7, 9831 Sint-Martens-Latem", "BEAM Vitality Center, Xavier de Cocklaan 70, boîte 7, 9831 Sint-Martens-Latem", "BEAM Vitality Center, Xavier de Cocklaan 70, box 7, 9831 Sint-Martens-Latem"][i]!, link: c.page("contact") },
      { heading: ["Groepsgrootte & opstelling", "Taille du groupe & configuration", "Group size & layout"][i]!, text: ["Het aantal deelnemers wordt afgestemd op het type bijeenkomst, de gewenste inrichting en het gebruik van de beschikbare faciliteiten.", "Le nombre de participants est adapté au type de rencontre, à l'aménagement souhaité et à l'utilisation des installations disponibles.", "The number of participants is tailored to the type of gathering, the desired layout and the use of the available facilities."][i]! },
      { heading: ["Exclusieve reservatie", "Réservation exclusive", "Exclusive booking"][i]!, text: ["BEAM kan op aanvraag exclusief worden gereserveerd voor zakelijke bijeenkomsten, presentaties, teamdagen en besloten evenementen.", "Sur demande, BEAM peut être réservé en exclusivité pour des rencontres professionnelles, des présentations, des journées d'équipe et des événements privés.", "On request, BEAM can be booked exclusively for business gatherings, presentations, team days and private events."][i]! },
      { heading: ["Programma & investering", "Programme & investissement", "Programme & investment"][i]!, text: ["Elke zakelijke bijeenkomst bij BEAM wordt zorgvuldig afgestemd op de doelstellingen en wensen van uw organisatie.", "Chaque rencontre professionnelle chez BEAM est soigneusement adaptée aux objectifs et aux souhaits de votre organisation.", "Every business gathering at BEAM is carefully tailored to your organisation's goals and wishes."][i]! },
    ],
  },
  contactCta(i, c, ["Ontdek BEAM als locatie voor uw volgende zakelijke bijeenkomst.", "Découvrez BEAM comme lieu pour votre prochaine rencontre professionnelle.", "Discover BEAM as the venue for your next business gathering."], [
    "Ontdek hoe BEAM professionaliteit, rust en een premium ervaring combineert voor uw team, klanten of organisatie.",
    "Découvrez comment BEAM allie professionnalisme, calme et une expérience premium pour votre équipe, vos clients ou votre organisation.",
    "Discover how BEAM combines professionalism, calm and a premium experience for your team, clients or organisation.",
  ]),
];

// ---------------------------------------------------------------------------
// BEAM Discovery Experience (beam.be/discovery-experience, Dutch only on the old site)
// ---------------------------------------------------------------------------

const DISCOVERY = (i: number, c: BuildCtx): Block[] => [
  hero(i, c, ["BEAM Discovery Experience", "BEAM Discovery Experience", "BEAM Discovery Experience"], [
    "Een begeleide ervaring van 3,5 uur voor teams die nieuwe energie willen opdoen, de onderlinge relaties willen versterken en een nieuw perspectief op welzijn willen ontdekken.",
    "Une expérience accompagnée de 3,5 heures pour les équipes qui veulent faire le plein d'énergie, renforcer leurs relations et découvrir un nouveau regard sur le bien-être.",
    "A guided 3.5-hour experience for teams who want to gain new energy, strengthen their relationships and discover a new perspective on wellbeing.",
  ], { label: REQUEST, link: c.page("contact") }, "corporate-discovery-banner"),
  imageText(i, c, "why", "corporate-discovery-reflection", "right", [{
    h: WHY,
    p: [
      ["In een wereld waarin de druk op mensen en organisaties blijft toenemen, wordt duurzame energie steeds belangrijker.", "Dans un monde où la pression sur les personnes et les organisations ne cesse d'augmenter, une énergie durable devient de plus en plus importante.", "In a world where the pressure on people and organisations keeps rising, sustainable energy is becoming ever more important."],
      ["Veel medewerkers functioneren op wilskracht. Ze blijven presteren, maar nemen steeds minder tijd om werkelijk te herstellen.", "Beaucoup de collaborateurs fonctionnent à la volonté. Ils continuent à performer, mais prennent de moins en moins le temps de vraiment récupérer.", "Many employees run on willpower. They keep performing, but take less and less time to truly recover."],
      ["Dat heeft niet alleen invloed op hun welzijn, maar ook op focus, creativiteit, samenwerking en betrokkenheid.", "Cela n'affecte pas seulement leur bien-être, mais aussi leur concentration, leur créativité, leur collaboration et leur engagement.", "That affects not only their wellbeing, but also focus, creativity, collaboration and engagement."],
      ["De **BEAM Discovery Experience** werd ontwikkeld als een inspirerende en toegankelijke kennismaking met een andere manier van kijken naar energie, stress en herstel.", "La **BEAM Discovery Experience** a été conçue comme une découverte inspirante et accessible d'une autre façon de considérer l'énergie, le stress et la récupération.", "The **BEAM Discovery Experience** was developed as an inspiring and accessible introduction to a different way of looking at energy, stress and recovery."],
    ],
  }]),
  investment(i, c),
  cards(i, c, "benefits", ["Wat uw team hieraan kan hebben", "Ce que votre équipe peut y gagner", "What your team can gain from it"], [
    { h: ["Scherpere focus en mentale helderheid", "Une concentration plus aiguë et une clarté mentale", "Sharper focus and mental clarity"], t: ["Neem even afstand van mentale overbelasting en creëer ruimte voor helderder denken en hernieuwde focus.", "Prenez un peu de recul face à la surcharge mentale et faites de la place pour une pensée plus claire et une concentration renouvelée.", "Step away from mental overload for a while and create room for clearer thinking and renewed focus."] },
    { h: ["Een hechtere band binnen het team", "Des liens plus forts au sein de l'équipe", "A closer bond within the team"], t: ["Versterk relaties door middel van een gezamenlijke ervaring die openheid en verbondenheid bevordert.", "Renforcez les relations grâce à une expérience partagée qui favorise l'ouverture et le sentiment d'appartenance.", "Strengthen relationships through a shared experience that fosters openness and connection."] },
    { h: ["Stressvermindering en een beter humeur", "Moins de stress et une meilleure humeur", "Less stress and a better mood"], t: ["Kom tot rust in een omgeving die is ontworpen om diepe ontspanning en emotioneel evenwicht te genereren.", "Retrouvez le calme dans un environnement conçu pour générer une détente profonde et un équilibre émotionnel.", "Unwind in an environment designed to bring about deep relaxation and emotional balance."] },
    { h: ["Duurzame prestaties", "Une performance durable", "Sustainable performance"], t: ["Creëer bewustwording rond herstel en gewoontes die het welzijn en de prestaties op de lange termijn ondersteunen.", "Sensibilisez à la récupération et aux habitudes qui soutiennent le bien-être et la performance à long terme.", "Build awareness of recovery and of habits that support wellbeing and performance in the long term."] },
  ], "list"),
  imageText(i, c, "programme", "corporate-discovery-welcome", "left", [
    {
      h: ["Een begeleide ervaring, ontworpen om indruk te maken.", "Une expérience accompagnée, conçue pour marquer les esprits.", "A guided experience, designed to make an impression."],
      h3: ["Wat je team ontvangt", "Ce que reçoit votre équipe", "What your team receives"],
      p: [["Een uitgebalanceerd programma dat inspiratie, diepe ontspanning en zinvolle bezinning combineert.", "Un programme équilibré qui associe inspiration, relaxation profonde et réflexion porteuse de sens.", "A balanced programme that combines inspiration, deep relaxation and meaningful reflection."]],
    },
    {
      h3: ["1. Een persoonlijk welkom", "1. Un accueil personnalisé", "1. A personal welcome"],
      p: [["We heten uw team welkom in een rustige en ontspannen omgeving met koffie, thee en gezonde hapjes. Tijdens dit welkom-moment maken de deelnemers kennis met BEAM en krijgen ze de kans om even afstand te nemen van hun dagelijkse werkomgeving.", "Nous accueillons votre équipe dans un cadre calme et détendu, avec café, thé et en-cas sains. Pendant ce moment d'accueil, les participants font connaissance avec BEAM et ont l'occasion de prendre un peu de distance avec leur environnement de travail quotidien.", "We welcome your team in a calm and relaxed setting with coffee, tea and healthy snacks. During this welcome, participants get to know BEAM and have the chance to step away from their daily work environment for a while."]],
    },
    {
      h3: ["2. Menselijke energie als basis", "2. L'énergie humaine comme fondement", "2. Human energy as the foundation"],
      p: [["We delen inzichten over stress, menselijke energie, de regulatie van het zenuwstelsel en het belang van herstel voor duurzame prestaties.", "Nous partageons des éclairages sur le stress, l'énergie humaine, la régulation du système nerveux et l'importance de la récupération pour une performance durable.", "We share insights into stress, human energy, nervous system regulation and the importance of recovery for sustainable performance."]],
    },
  ]),
  imageText(i, c, "programme-2", "corporate-venue-hr", "right", [
    {
      h3: ["3. De BEAM Experience", "3. La BEAM Experience", "3. The BEAM Experience"],
      p: [["Twee uur in onze unieke EESystem-omgeving met 48 units om even tot rust te komen, te ontspannen en diepe ontspanning te ervaren.", "Deux heures dans notre environnement EESystem unique de 48 unités pour se poser, se détendre et faire l'expérience d'une relaxation profonde.", "Two hours in our unique 48-unit EESystem environment to come to rest, unwind and experience deep relaxation."]],
    },
    {
      h3: ["4. Reflectie en discussie", "4. Réflexion et échange", "4. Reflection and discussion"],
      p: [["Deel ervaringen, stel vragen en doe praktische inzichten op om je persoonlijke groei te stimuleren, een beter teamlid te worden en je doelen op het gebied van persoonlijk welzijn te bereiken.", "Partagez vos expériences, posez vos questions et repartez avec des clés concrètes pour stimuler votre développement personnel, devenir un meilleur coéquipier et atteindre vos objectifs de bien-être personnel.", "Share experiences, ask questions and gain practical insights to boost your personal growth, become a better team member and reach your personal wellbeing goals."]],
    },
  ]),
  nextSteps(i, c),
  rt(i, c, "audience-intro", [{
    h: ["Voor wie is de BEAM Discovery Experience bedoeld?", "À qui s'adresse la BEAM Discovery Experience ?", "Who is the BEAM Discovery Experience for?"],
    p: [["Een ideale ervaring voor organisaties die hun medewerkers waarderen.", "Une expérience idéale pour les organisations qui tiennent à leurs collaborateurs.", "An ideal experience for organisations that value their employees."]],
  }]),
  iconCards(i, c, "audience", null, [
    { icon: "individuals", h: ["Waardering voor medewerkers", "Valoriser vos collaborateurs", "Appreciation for employees"], t: ["Toon je waardering voor het harde werk van je team met een bijzondere ervaring die rust, ontspanning en nieuwe energie bevordert.", "Montrez votre reconnaissance pour le travail de votre équipe avec une expérience unique qui favorise le calme, la détente et une énergie nouvelle.", "Show your appreciation for your team's hard work with a special experience that promotes calm, relaxation and new energy."] },
    { icon: "professionals", h: ["Versterk de band binnen het team", "Renforcer les liens au sein de l'équipe", "Strengthen the bond within the team"], t: ["Breng collega’s buiten de werkplek bij elkaar om persoonlijke banden te versterken en gezamenlijke reflectie te stimuleren.", "Réunissez vos collègues en dehors du lieu de travail pour renforcer les liens personnels et encourager la réflexion commune.", "Bring colleagues together outside the workplace to strengthen personal bonds and encourage shared reflection."] },
    { icon: "organisations", h: ["Geef prioriteit aan het welzijn van je medewerkers", "Faire du bien-être de vos collaborateurs une priorité", "Prioritise your employees' wellbeing"], t: ["Maak medewerkers bewust van het belang van stressbeheersing en herstel, en stimuleer gezondere gewoontes en een groter bewustzijn van hun welzijn.", "Sensibilisez vos collaborateurs à l'importance de la gestion du stress et de la récupération, et encouragez des habitudes plus saines et une meilleure conscience de leur bien-être.", "Make employees aware of the importance of stress management and recovery, and encourage healthier habits and greater awareness of their wellbeing."] },
    { icon: "leaders", h: ["Ondersteuning van leidinggevende teams", "Soutenir les équipes dirigeantes", "Supporting leadership teams"], t: ["Geef leidinggevenden de kans om even afstand te nemen van de dagelijkse druk, na te denken over hun energie en terug te keren met meer helderheid.", "Donnez aux dirigeants l'occasion de prendre un peu de recul face à la pression quotidienne, de réfléchir à leur énergie et de revenir avec plus de clarté.", "Give leaders the chance to step away from daily pressure, reflect on their energy and return with more clarity."] },
  ]),
  contactCta(i, c, ["Geef je team de ruimte om op te laden en verder te ontplooien.", "Donnez à votre équipe l'espace pour se ressourcer et s'épanouir.", "Give your team room to recharge and keep growing."], [
    "Een verfrissende teamervaring. Ontsnap even aan de dagelijkse druk en bied uw medewerkers een ervaring die zorgt voor nieuwe energie, hechtere banden en een gezondere benadering van duurzame prestaties.",
    "Une expérience d'équipe rafraîchissante. Échappez un instant à la pression quotidienne et offrez à vos collaborateurs une expérience qui apporte une énergie nouvelle, des liens plus forts et une approche plus saine de la performance durable.",
    "A refreshing team experience. Escape the daily pressure for a while and offer your employees an experience that brings new energy, closer bonds and a healthier approach to sustainable performance.",
  ]),
];

export const PAGES: Record<string, PageModule> = {
  corporate: { build: CORPORATE, media },
  "corporate-reset-day": {
    build: RESET_DAY,
    meta: {
      slug: "corporate-reset-day",
      kind: "standard",
      title: ["Corporate Reset Day", "Corporate Reset Day", "Corporate Reset Day"],
      path: ["corporate-reset-day", "corporate-reset-day", "corporate-reset-day"],
      description: [
        "Corporate Reset Day bij BEAM Vitality Center in Sint-Martens-Latem: een begeleide teamdag rond stressbeheersing, herstel en menselijke energie.",
        "Corporate Reset Day au BEAM Vitality Center à Sint-Martens-Latem : une journée d'équipe accompagnée autour de la gestion du stress, de la récupération et de l'énergie humaine.",
        "Corporate Reset Day at BEAM Vitality Center in Sint-Martens-Latem: a guided team day on stress management, recovery and human energy.",
      ],
    },
  },
  "corporate-venue": {
    build: VENUE,
    meta: {
      slug: "corporate-venue",
      kind: "standard",
      title: ["BEAM Corporate Venue", "BEAM Corporate Venue", "BEAM Corporate Venue"],
      path: ["corporate-venue", "corporate-venue", "corporate-venue"],
      description: [
        "BEAM Vitality Center in Sint-Martens-Latem biedt bedrijven een premium locatie voor bijeenkomsten die meer verdienen dan een klassieke vergader- of evenementruimte.",
        "Le BEAM Vitality Center à Sint-Martens-Latem offre aux entreprises un lieu premium pour des rencontres qui méritent plus qu'une salle de réunion ou d'événement classique.",
        "BEAM Vitality Center in Sint-Martens-Latem offers companies a premium venue for gatherings that deserve more than a classic meeting or event space.",
      ],
    },
  },
  "discovery-experience": {
    build: DISCOVERY,
    meta: {
      slug: "discovery-experience",
      kind: "standard",
      title: ["BEAM Discovery Experience", "BEAM Discovery Experience", "BEAM Discovery Experience"],
      path: ["discovery-experience", "discovery-experience", "discovery-experience"],
      description: [
        "BEAM Discovery Experience: een begeleide ervaring van 3,5 uur voor teams bij BEAM Vitality Center in Sint-Martens-Latem, rond energie, stress en herstel.",
        "BEAM Discovery Experience : une expérience accompagnée de 3,5 heures pour les équipes au BEAM Vitality Center à Sint-Martens-Latem, autour de l'énergie, du stress et de la récupération.",
        "BEAM Discovery Experience: a guided 3.5-hour experience for teams at BEAM Vitality Center in Sint-Martens-Latem, about energy, stress and recovery.",
      ],
    },
  },
};
