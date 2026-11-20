/**
 * Site pages of the "space" group: the environment and the technology. Every line of beam.be's
 * /omgeving and /technologie (nl, docs/research/beam-be/omgeving.md, technologie.md) and their
 * English pages is kept verbatim (French translated), told as a hero, chapters, statement bands,
 * cards and photos beside the text. `space.coverage.test.ts` fails when a line goes missing.
 */
import {
  DAY_NOTE, FAQ_TECH, L_DAY, L_NIGHT, NIGHT_NOTE,
  book, cards, chapter, cta, faq, hero, iconCards, imageText, rt, statement,
  type BuildCtx, type Builder, type L3, type MediaSeed, type PageModule,
} from "../site-kit";

const MEDIA = {
  "space-system": { file: "Het-EESystem™-is-deel-600x400-1.webp", alt: ["Gasten mediteren met gesloten ogen in zetels voor de EESystem-schermen", "Des hôtes méditent les yeux fermés dans des fauteuils devant les écrans EESystem", "Guests meditating with closed eyes in armchairs in front of the EESystem screens"] },
  "space-concepts": { file: "Technology-De-concepten-die-ten-500-x-600.webp", alt: ["De BEAM-ruimte met gasten die mediteren op kussens en rusten in bedden en zetels", "L'espace BEAM avec des hôtes qui méditent sur des coussins et se reposent dans des lits et des fauteuils", "The BEAM space with guests meditating on cushions and resting in beds and armchairs"] },
} satisfies Record<string, MediaSeed>;

/** Said on both pages: the coherence principle. */
const COHERENCE_PROCESSES: L3 = [
  "Wanneer deze processen op elkaar zijn afgestemd, reguleert het lichaam zich efficiënter en kosten herstelprocessen minder inspanning. Hetzelfde principe geldt voor de ruimte waarin een organisme zich bevindt.",
  "Lorsque ces processus sont accordés entre eux, le corps se régule plus efficacement et les processus de récupération demandent moins d'effort. Le même principe s'applique à l'espace dans lequel se trouve un organisme.",
  "When these processes are aligned, the body regulates more efficiently and recovery processes can function with less effort. The same principle applies to the environment surrounding the organism.",
];
const COHERENCE_STATEMENT: L3[] = [
  ["Coherentie dwingt geen verandering af.", "La cohérence n'impose aucun changement.", "Coherence does not force change."],
  ["Het stelt het systeem in staat zichzelf **effectiever te organiseren**.", "Elle permet au système de **s'organiser plus efficacement**.", "It allows the system to organise itself **more effectively**."],
];
const quickBook = (i: number, c: BuildCtx) => [
  book(i, c, "book-day", L_DAY, { kind: "book_day" }, DAY_NOTE),
  book(i, c, "book-night", L_NIGHT, { kind: "book_night" }, NIGHT_NOTE),
];

const ENVIRONMENT: Builder = (i, c) => [
  hero(i, c, ["De BEAM-omgeving", "L'environnement BEAM", "The Environment"], ["Ontworpen voor herstel", "Conçu pour la récupération", "Designed for restoration"], undefined, "hero"),
  ...quickBook(i, c),
  statement(i, c, "principle", [
    ["BEAM vertrekt vanuit één eenvoudig principe:", "BEAM part d'un principe simple :", "BEAM is built on a simple principle:"],
    ["Menselijke systemen herstellen wanneer **de omgeving** het toelaat.", "Les systèmes humains se rétablissent lorsque **l'environnement** le permet.", "Human systems restore when **the environment** allows them to."],
  ]),
  chapter(i, c, "intro", [{ p: [
    [
      "Het lichaam reageert voortdurend op de omstandigheden waarin het zich bevindt. Wanneer die omstandigheden stabiel, coherent en rustig zijn, kan het zenuwstelsel efficiënter reguleren. Door die regulatie wordt herstel mogelijk. En vanuit herstel ontstaat opnieuw vitaliteit.",
      "Le corps réagit en permanence aux conditions dans lesquelles il se trouve. Lorsque ces conditions sont stables, cohérentes et calmes, le système nerveux peut se réguler plus efficacement. Grâce à cette régulation, la récupération devient possible. Et de la récupération naît à nouveau la vitalité.",
      "The body continuously responds to the conditions it inhabits. When those conditions are stable, coherent and calm, the nervous system can regulate more efficiently. From regulation, recovery becomes possible. From recovery, vitality returns.",
    ],
    ["**Bij BEAM richten we ons op de omgeving, niet op het individu.**", "**Chez BEAM, nous agissons sur l'environnement, pas sur l'individu.**", "**At BEAM, we focus on the environment — not the individual.**"],
  ] }]),
  chapter(i, c, "signals", [{
    h: ["Biologische systemen functioneren niet op zichzelf. Ze worden beïnvloed door **signalen van buitenaf**.", "Les systèmes biologiques ne fonctionnent pas isolément. Ils sont influencés par des **signaux extérieurs**.", "Biological systems do not function in isolation. They are **shaped by external signals**."],
    h3: ["Regulatie begint bij de omgeving", "La régulation commence par l'environnement", "Regulation begins with the environment"],
    list: [
      ["Licht reguleert het circadiane ritme.", "La lumière règle le rythme circadien.", "Light regulates circadian rhythms."],
      ["Geluid beïnvloedt de hersenactiviteit.", "Le son influence l'activité cérébrale.", "Sound influences neural activity."],
      ["Temperatuur en zintuiglijke prikkels beïnvloeden stress en herstel.", "La température et les stimuli sensoriels influencent le stress et la récupération.", "Temperature and sensory input affect stress and recovery."],
    ],
  }, { p: [["Het lichaam interpreteert voortdurend zijn omgeving en past zich daaraan aan.", "Le corps interprète en permanence son environnement et s'y adapte.", "The body constantly interprets its surroundings and adapts accordingly."]] }]),
  cards(i, c, "pathway", ["Het pad is helder:", "Le chemin est clair :", "A clear pathway emerges:"], [
    { h: ["Omgeving", "Environnement", "Environment"], t: ["", "", ""] },
    { h: ["Zenuwstelsel", "Système nerveux", "Nervous system"], t: ["", "", ""] },
    { h: ["Fysiologische reactie", "Réaction physiologique", "Physiological response"], t: ["", "", ""] },
  ], "list"),
  chapter(i, c, "evidence", [{ p: [
    [
      "Deze onderlinge wisselwerking is goed gedocumenteerd. Onderzoek naar natuurlijke omgevingen, waaronder een verblijf in het bos (Shinrin-yoku), toont een meetbare afname van **stressmarkers** aan, **een verbeterde hartslagvariabiliteit** en **een verhoogde activiteit van het parasympathisch zenuwstelsel**.",
      "Cette interaction est bien documentée. Les recherches sur les environnements naturels, dont les séjours en forêt (Shinrin-yoku), montrent une baisse mesurable des **marqueurs de stress**, **une meilleure variabilité de la fréquence cardiaque** et **une activité accrue du système nerveux parasympathique**.",
      "This relationship is well documented. Studies on natural environments, including forest exposure (Shinrin-yoku), show measurable reductions in **stress markers**, **improved heart rate variability**, and **increased parasympathetic activity**.",
    ],
    ["Dit is geen toeval. Het is het leidende principe achter elke ontwerpkeuze van de BEAM-ruimte.", "Ce n'est pas un hasard. C'est le principe directeur de chaque choix de conception de l'espace BEAM.", "This relationship is not incidental. It is the organising principle behind every choice made in the design of the BEAM environment."],
    ["**Wanneer de externe omstandigheden coherent en stabiel zijn, hoeft het lichaam niet voortdurend verstoringen te compenseren.**", "**Lorsque les conditions extérieures sont cohérentes et stables, le corps n'a pas à compenser sans cesse des perturbations.**", "**When external conditions are consistent and stable, the body does not have to constantly compensate for disruptions.**"],
  ] }]),
  chapter(i, c, "coherence", [{
    h: ["**Coherentie** is geen bijzaak bij BEAM. Het is de basis.", "La **cohérence** n'est pas un détail chez BEAM. C'est la base.", "A defining characteristic of the BEAM environment is **coherence**."],
    h3: ["Coherentie en biologische stabiliteit", "Cohérence et stabilité biologique", "Coherence and biological stability"],
    p: [[
      "In de natuurkunde verwijst coherentie naar de onderlinge afstemming en consistentie van signalen. In biologische systemen komen soortgelijke patronen op meetbare wijze tot uiting:",
      "En physique, la cohérence désigne l'alignement et la constance des signaux. Dans les systèmes biologiques, des schémas similaires se manifestent de manière mesurable :",
      "In physics, coherence refers to the alignment and consistency of signals. In biological systems, similar patterns appear in measurable ways:",
    ]],
    list: [
      ["Gesynchroniseerde hartritmes (HRV-coherentie)", "Des rythmes cardiaques synchronisés (cohérence de la VFC)", "Synchronized heart rhythms (HRV coherence)"],
      ["Gecoördineerde neurale activiteit", "Une activité neuronale coordonnée", "Coordinated neural activity"],
      ["Stabiliteit van het autonome zenuwstelsel", "La stabilité du système nerveux autonome", "Stable autonomic nervous system balance"],
      ["Efficiënte cellulaire communicatie", "Une communication cellulaire efficace", "Efficient cellular communication"],
    ],
  }, { p: [COHERENCE_PROCESSES] }]),
  statement(i, c, "coherence-statement", COHERENCE_STATEMENT),
  imageText(i, c, "resonance", "space-system", "left", [{
    h: ["Wanneer de omgeving **coherent** is, volgt het **lichaam van vanzelf**.", "Lorsque l'environnement est **cohérent**, le **corps suit de lui-même**.", "When the environment is **coherent**, the body **naturally follows**."],
    h3: ["Resonantie en biologische afstemming", "Résonance et accord biologique", "Resonance and biological entrainment"],
    p: [
      [
        "Een van de fundamentele principes in zowel de natuurkunde als de biologie is **resonantie**, de neiging van systemen om te synchroniseren wanneer ze worden blootgesteld aan coherente externe signalen.",
        "L'un des principes fondamentaux de la physique comme de la biologie est la **résonance**, la tendance des systèmes à se synchroniser lorsqu'ils sont exposés à des signaux extérieurs cohérents.",
        "One of the most fundamental principles in both physics and biology is **resonance**, the tendency of systems to synchronise when exposed to coherent external signals.",
      ],
      [
        "De Nederlandse natuurkundige Christiaan Huygens observeerde dit voor het eerst in 1665, toen twee slingerklokken aan dezelfde muur spontaan in synchronie gingen tikken. Hij noemde dit ‘wederzijdse sympathische afstemming’. Hetzelfde principe is werkzaam in de biologische wereld. Synchronisatie tussen neuronen tijdens gedeelde ervaringen, tussen de hartslag van mensen in elkaars nabijheid en tussen het lichaam en een coherente omgeving.",
        "Le physicien néerlandais Christiaan Huygens l'a observé pour la première fois en 1665, lorsque deux horloges à balancier fixées au même mur se sont spontanément mises à battre en synchronie. Il a appelé ce phénomène « accord sympathique mutuel ». Le même principe est à l'œuvre dans le monde biologique : synchronisation entre les neurones lors d'expériences partagées, entre les battements de cœur de personnes proches les unes des autres, et entre le corps et un environnement cohérent.",
        "The Dutch physicist Christiaan Huygens first observed this in 1665, when two pendulum clocks mounted on the same wall spontaneously fell into synchrony. He called it ‘mutual sympathetic entrainment’. The same phenomenon occurs throughout the biological world. Between human hearts in proximity, between neurons during shared experience, and between the body and a coherent environment.",
      ],
      [
        "Voor levende systemen is resonantie geen uitzondering. Het is een fundamenteel organiserend principe. Wanneer de omgeving stabiel en coherent is, beginnen biologische systemen er van nature op af te stemmen. Niet via kracht of interventie, maar via hetzelfde principe dat slingerklokken, orkesten en menselijke harten op elkaar afstemt.",
        "Pour les systèmes vivants, la résonance n'est pas une exception. C'est un principe organisateur fondamental. Lorsque l'environnement est stable et cohérent, les systèmes biologiques commencent naturellement à s'y accorder. Non par la force ou l'intervention, mais selon le même principe qui accorde entre eux les horloges à balancier, les orchestres et les cœurs humains.",
        "For living systems, resonance is not an exception. It is a fundamental organising principle. When the surrounding environment is stable and coherent, biological systems naturally begin to attune to it. Not through force or intervention, but through the same principle that governs pendulum clocks, orchestras and human hearts.",
      ],
      ["**Bij BEAM is dit principe geen bijzaak. Het is de basis.**", "**Chez BEAM, ce principe n'est pas un détail. C'est la base.**", "**At BEAM, this principle is not incidental. It is foundational.**"],
    ],
  }]),
  statement(i, c, "nothing", [
    ["Je hoeft niets te doen. Geen techniek toepassen, geen inspanning leveren.", "Vous n'avez rien à faire. Aucune technique à appliquer, aucun effort à fournir.", "There is nothing to perform, no technique to apply and no effort required."],
    ["Je begeeft je gewoon in de ruimte waarin **herstel** vanzelf gebeurt.", "Vous entrez simplement dans l'espace où la **récupération** se fait d'elle-même.", "You simply enter an environment where **restoration** becomes possible."],
  ]),
  cards(i, c, "provide", ["BEAM is ontworpen om het volgende te bieden:", "BEAM est conçu pour offrir :", "BEAM is designed to provide:"], [
    { h: ["Stabiliteit", "Stabilité", "Stability"], t: ["Het verminderen van onnodige prikkels", "En réduisant les stimulations inutiles", "Reducing unnecessary stimulation"] },
    { h: ["Consistentie", "Constance", "Consistency"], t: ["Waardoor het zenuwstelsel tot rust kan komen", "Pour que le système nerveux puisse s'apaiser", "Allowing the nervous system to settle"] },
    { h: ["Coherentie", "Cohérence", "Coherence"], t: ["Voor meer efficiënte regulatie", "Pour une régulation plus efficace", "Supporting efficient regulation"] },
  ]),
  chapter(i, c, "rhythm", [{ p: [["Binnen deze omstandigheden kan het lichaam terugkeren naar zijn **natuurlijke ritme**.", "Dans ces conditions, le corps peut retrouver son **rythme naturel**.", "Within such conditions, the body can return to its **natural rhythms**."]] }]),
  imageText(i, c, "eesystem", "beds", "right", [{
    h: ["In het hart van de BEAM-omgeving bevindt zich het **EESystem**.", "Au cœur de l'environnement BEAM se trouve l'**EESystem**.", "At the heart of the BEAM environment is the **EESystem**."],
    h3: ["Technologie ten dienste van de omgeving", "La technologie au service de l'environnement", "Technology in service of the environment"],
    p: [
      ["In het hart van de BEAM-omgeving bevindt zich het Energy Enhancement System™, geïntegreerd in een zorgvuldig ontworpen en gestructureerde ruimte.", "Au cœur de l'environnement BEAM se trouve l'Energy Enhancement System™, intégré dans un espace soigneusement conçu et structuré.", "At the heart of the BEAM environment is the Energy Enhancement System™ (EESystem™), integrated as part of a carefully designed and structured space."],
      ["De technologie grijpt niet in op het lichaam, maar draagt bij aan de omstandigheden eromheen. Dit weerspiegelt hoe BEAM is ontworpen:", "La technologie n'agit pas sur le corps, elle contribue aux conditions qui l'entourent. C'est le reflet de la manière dont BEAM a été conçu :", "The technology does not act on the body. It contributes to the conditions surrounding it. This reflects how BEAM is designed to function:"],
    ],
  }]),
  statement(i, c, "supports", [
    ["De technologie ondersteunt **de omgeving**.", "La technologie soutient **l'environnement**.", "The technology supports **the environment**."],
    ["De omgeving ondersteunt **het lichaam**.", "L'environnement soutient **le corps**.", "The environment supports **the body**."],
  ]),
  imageText(i, c, "entering", "night", "left", [{
    h: ["Wanneer mensen de **BEAM-ruimte** binnenstappen.", "Quand on entre dans l'**espace BEAM**.", "Stepping into the **BEAM environment**."],
    h3: ["Vanaf het eerste moment", "Dès le premier instant", "From the first moment"],
    p: [[
      "Wanneer mensen de BEAM-ruimte binnenstappen, merken de meesten binnen enkele minuten een verandering. De kwaliteit van de lucht voelt anders. De geest, die zelden stilstaat, begint te vertragen. Er is niets te doen en niets om weerstand tegen te bieden. Veel gasten beschrijven het eenvoudigweg als de diepste vorm van stilte die ze in jaren hebben ervaren. Het gevoel dat het lichaam eindelijk toestemming krijgt om te stoppen met compenseren en simpelweg te zijn.",
      "Lorsqu'elles entrent dans l'espace BEAM, la plupart des personnes remarquent un changement en quelques minutes. La qualité de l'air semble différente. L'esprit, qui s'arrête rarement, commence à ralentir. Il n'y a rien à faire et rien à quoi résister. Beaucoup d'hôtes le décrivent simplement comme le silence le plus profond qu'ils aient connu depuis des années. Le sentiment que le corps reçoit enfin la permission d'arrêter de compenser et de simplement être.",
      "Stepping into the BEAM environment, most people notice something shift within the first few minutes. The quality of the air feels different. The mind, which rarely stops, begins to slow. There is nothing to do and nothing to resist. Many guests describe it simply as the deepest stillness they have felt in years. A sense that the body has finally been given permission to stop compensating and simply be.",
    ]],
  }]),
  chapter(i, c, "experience", [{
    h: ["Wat mensen vaak **opvalt**", "Ce que les gens **remarquent** souvent", "What people often **notice**"],
    h3: ["De ervaring", "L'expérience", "The experience"],
    p: [[
      "Wanneer het zenuwstelsel de ruimte krijgt om te functioneren binnen stabiele en coherente omstandigheden, ervaren mensen vaak:",
      "Lorsque le système nerveux a l'espace pour fonctionner dans des conditions stables et cohérentes, les gens ressentent souvent :",
      "When the nervous system is able to regulate within stable and coherent conditions, people often report:",
    ]],
    list: [
      ["Een dieper gevoel van fysieke en mentale ontspanning", "Une sensation plus profonde de détente physique et mentale", "A deeper sense of physical relaxation"],
      ["Verbeterde slaapkwaliteit", "Une meilleure qualité de sommeil", "Improved sleep quality"],
      ["Meer mentale helderheid en focus", "Plus de clarté mentale et de concentration", "Greater mental clarity and focus"],
      ["Sneller herstel van vermoeidheid", "Une récupération plus rapide après la fatigue", "Faster recovery from fatigue"],
      ["Minder stress en ontspanning van het zenuwstelsel", "Moins de stress et un système nerveux détendu", "Reduced stress and nervous system tension"],
      ["Een stabieler energieniveau", "Un niveau d'énergie plus stable", "A more stable level of energy"],
    ],
  }, { p: [[
    "Deze ervaringen komen overeen met de manier waarop **biologische systemen reageren wanneer de voorwaarden voor regulatie en herstel vervuld zijn**.",
    "Ces expériences correspondent à la manière dont **les systèmes biologiques réagissent lorsque les conditions de la régulation et de la récupération sont réunies**.",
    "These experiences are consistent with how **biological systems respond when the conditions for regulation and recovery are present**.",
  ]] }]),
  imageText(i, c, "long-term", "day", "right", [{
    h: ["De effecten van **consistent herstel reiken** verder dan hoe mensen zich voelen na een sessie.", "Les effets d'une **récupération régulière** vont au-delà de ce que l'on ressent après une séance.", "The effects of **consistent restoration** extend beyond how people feel after a session."],
    h3: ["De langetermijndimensie", "La dimension à long terme", "The long-term dimension"],
    p: [
      ["**Longevity-onderzoek** toont keer op keer aan dat **mitochondriale processen** een sleutelrol spelen in hoe we verouderen en hoe vitaal we blijven.", "**Les recherches sur la longévité** montrent à maintes reprises que **les processus mitochondriaux** jouent un rôle clé dans notre manière de vieillir et de rester vitaux.", "**Longevity science** consistently identifies **mitochondrial function** as central to biological aging and lasting vitality."],
      [
        "De biologische omstandigheden voor gezond ouder worden zijn aanwezig wanneer cellulaire energie consistent wordt ondersteund, wanneer het zenuwstelsel niet langer chronisch geactiveerd is, en wanneer de herstellende processen van het lichaam kunnen functioneren zoals ze bedoeld zijn.",
        "Les conditions biologiques d'un vieillissement en bonne santé sont réunies lorsque l'énergie cellulaire est soutenue de manière constante, lorsque le système nerveux n'est plus activé en permanence et lorsque les processus de réparation du corps peuvent fonctionner comme prévu.",
        "The biological conditions for healthy aging are present when cellular energy is consistently supported, when the nervous system is no longer chronically activated, and when the body’s repair processes can function as intended.",
      ],
      [
        "**De lengte van de telomeren** — de beschermende uiteinden van chromosomen die korter worden naarmate stress zich opstapelt — blijft beter bewaard wanneer herstel consistent is. **Hartslagvariabiliteit**, een primaire marker van biologische leeftijd, verbetert wanneer het autonome zenuwstelsel regelmatig wordt ondersteund.",
        "**La longueur des télomères** — les extrémités protectrices des chromosomes, qui raccourcissent à mesure que le stress s'accumule — se préserve mieux lorsque la récupération est régulière. **La variabilité de la fréquence cardiaque**, un marqueur essentiel de l'âge biologique, s'améliore lorsque le système nerveux autonome est régulièrement soutenu.",
        "**Telomere length** — the protective caps on chromosomes that shorten with accumulated stress — is preserved when recovery is consistent. **Heart rate variability**, a primary marker of biological age, improves when the autonomic nervous system is regularly supported.",
      ],
    ],
  }]),
  statement(i, c, "vitality", [
    ["Duurzame vitaliteit en gezond ouder worden zijn de **natuurlijke uitkomst** van consistente regulatie en herstel.", "La vitalité durable et le vieillissement en bonne santé sont **l'aboutissement naturel** d'une régulation et d'une récupération constantes.", "Sustained vitality and healthy aging are not separate goals from regulation and recovery. They are their **natural expression** over time."],
    ["Dit is de diepere, langetermijnwaarde van wat BEAM biedt.", "C'est la valeur profonde, à long terme, de ce que BEAM offre.", "This is the long-term dimension of what BEAM supports."],
  ]),
  imageText(i, c, "approach", "portrait", "left", [{
    h: ["BEAM **dwingt het lichaam** niet om te **presteren**.", "BEAM ne **pousse pas le corps** à la **performance**.", "BEAM **does not push** the system to **perform**."],
    h3: ["Een andere aanpak", "Une autre approche", "A different approach"],
    p: [
      ["BEAM onderdrukt geen symptomen en vraagt het lichaam niet om harder zijn best te doen. In plaats daarvan creëert het de omstandigheden waarin het lichaam kan functioneren zoals het bedoeld is.", "BEAM ne réprime pas les symptômes et ne demande pas au corps de faire plus d'efforts. Au contraire, il crée les conditions dans lesquelles le corps peut fonctionner comme il est censé le faire.", "It does not override symptoms or ask the body to try harder. Instead, it creates the conditions in which the body can function as it is designed to."],
      ["**BEAM grijpt niet in op mensen. Het vormt de omgeving zodat het lichaam de rest kan doen.**", "**BEAM n'agit pas sur les personnes. Il façonne l'environnement pour que le corps puisse faire le reste.**", "**BEAM does not act on people. It shapes the environment — so the body can do the rest.**"],
    ],
  }]),
  cta(i, c, "cta", ["Ontdek de technologie", "Découvrez la technologie", "Discover the technology"], ["48 gesynchroniseerde EESystem-units, geïntegreerd in de ruimte.", "48 unités EESystem synchronisées, intégrées à l'espace.", "48 synchronised EESystem units, built into the space."], ["Meer over de technologie", "En savoir plus", "More about the technology"], c.page("technology")),
];

const TECHNOLOGY: Builder = (i, c) => [
  hero(i, c, ["EESystem-technologie: hoe het werkt bij BEAM Vitality Center", "La technologie EESystem : comment elle fonctionne chez BEAM Vitality Center", "The Energy Enhancement System™ at BEAM: how it works"], ["De technologie: een systeem geïntegreerd in de ruimte.", "La technologie : un système intégré à l'espace.", "The technology: a system integrated into the environment."]),
  ...quickBook(i, c),
  chapter(i, c, "intro", [{ p: [[
    "Het Energy Enhancement System™ (EESystem) is een niet-invasieve technologie die is geïntegreerd in de BEAM-omgeving. Niet om in te grijpen op het lichaam, maar om bij te dragen aan de stabiliteit en coherentie van de ruimte waarin het lichaam zich bevindt.",
    "L'Energy Enhancement System™ (EESystem) est une technologie non invasive intégrée à l'environnement BEAM. Non pas pour agir sur le corps, mais pour contribuer à la stabilité et à la cohérence de l'espace dans lequel il se trouve.",
    "The Energy Enhancement System™ (EESystem) is a non-invasive, energy-based technology integrated into the BEAM environment. Its role is not to act on the body, but to contribute to the stability and structure of the space in which the body operates.",
  ]] }]),
  chapter(i, c, "biology", [{
    h: ["Het menselijk lichaam steunt op **nauwkeurig afgestemde elektrochemische processen**.", "Le corps humain repose sur des **processus électrochimiques finement réglés**.", "The human organism relies on **finely regulated electrochemical processes**."],
    h3: ["De biologische basis", "Le fondement biologique", "The biological foundation"],
    p: [
      ["De omgeving waarin je lichaam verkeert, beïnvloedt rechtstreeks hoe goed het kan functioneren. Wanneer die omgeving stabiel en coherent is, verlopen biologische processen efficiënter. Wanneer ze verstoord is, kost alles meer moeite.", "L'environnement dans lequel se trouve votre corps influence directement sa capacité à bien fonctionner. Lorsque cet environnement est stable et cohérent, les processus biologiques se déroulent plus efficacement. Lorsqu'il est perturbé, tout demande plus d'effort.", "The environment in which your body exists directly influences how well it can function. When that environment is stable and coherent, biological processes run more efficiently. When it is disrupted, everything takes more effort."],
      [
        "Elke cel heeft een membraanpotentiaal — een **elektrische spanning over de celwand** die essentieel is voor communicatie, transport en energieproductie. De stabiliteit van die spanning bepaalt mee hoe efficiënt cellen samenwerken en hoe goed het lichaam zichzelf reguleert.",
        "Chaque cellule possède un potentiel de membrane — une **tension électrique à travers la paroi cellulaire**, essentielle à la communication, au transport et à la production d'énergie. La stabilité de cette tension détermine en partie l'efficacité avec laquelle les cellules coopèrent et la capacité du corps à se réguler.",
        "Every cell maintains a **membrane potential** — a voltage difference essential for communication, transport and metabolic activity. Neural signaling, cardiac rhythm and cellular energy production all depend on the stability of these dynamics.",
      ],
      ["Wanneer de omstandigheden stabiel zijn, kunnen biologische systemen zich efficiënt coördineren en reguleren.", "Lorsque les conditions sont stables, les systèmes biologiques peuvent se coordonner et se réguler efficacement.", "When these conditions are stable, biological systems can coordinate and regulate efficiently."],
    ],
  }]),
  statement(i, c, "findings", [
    ["Deze bevindingen ondersteunen een breder inzicht:", "Ces découvertes appuient une compréhension plus large :", "These findings support a broader understanding:"],
    ["Biologische functies worden niet alleen beïnvloed door chemie, maar ook door **elektrische en fotonische dynamieken**.", "Les fonctions biologiques ne sont pas seulement influencées par la chimie, mais aussi par des **dynamiques électriques et photoniques**.", "Biological function is influenced not only by chemistry, but also by **electrical and photonic dynamics**."],
  ]),
  imageText(i, c, "light", "relax", "left", [{
    h: ["Biologische systemen reageren ook op **licht en elektromagnetische signalen**.", "Les systèmes biologiques réagissent aussi à la **lumière et aux signaux électromagnétiques**.", "Biological systems are also responsive to **light and electromagnetic signals**"],
    h3: ["Licht, energie en cellulaire activiteit", "Lumière, énergie et activité cellulaire", "Light, energy and cellular activity"],
    p: [
      [
        "Onderzoek naar **‘fotobiomodulatie’** toont aan dat specifieke lichtgolven het celmetabolisme kunnen beïnvloeden. Nabij-infraroodlicht wordt daarbij in verband gebracht met **verhoogde mitochondriale activiteit en een hogere ATP-productie** — de primaire bron van cellulaire energie.",
        "Les recherches sur la **« photobiomodulation »** montrent que certaines longueurs d'onde lumineuses peuvent influencer le métabolisme cellulaire. La lumière proche infrarouge est ainsi associée à **une activité mitochondriale accrue et à une production d'ATP plus élevée** — la principale source d'énergie cellulaire.",
        "Research in **photobiomodulation** shows that specific wavelengths of light can influence cellular metabolism. In particular, near-infrared light has been associated with **increased mitochondrial activity and ATP production**, the primary source of cellular energy.",
      ],
      [
        "Daarnaast introduceerde biofysicus Fritz-Albert Popp het concept dat levende cellen, als onderdeel van metabolische processen, ultra-zwakke lichtdeeltjes uitzenden, ook wel **‘biofotonen’** genoemd.",
        "Le biophysicien Fritz-Albert Popp a par ailleurs introduit l'idée que les cellules vivantes émettent, dans le cadre de leurs processus métaboliques, des particules de lumière ultra-faibles, appelées **« biophotons »**.",
        "In parallel, the work of biophysicist Fritz-Albert Popp introduced the concept that living cells emit ultra-weak photons, known as **biophotons**, as part of metabolic processes.",
      ],
    ],
  }]),
  rt(i, c, "structure", [{
    h: ["Het Energy Enhancement System™ bestaat uit meerdere **gesynchroniseerde schermen** in een nauwkeurige ruimtelijke opstelling.", "L'Energy Enhancement System™ se compose de plusieurs **écrans synchronisés** disposés selon une configuration spatiale précise.", "The Energy Enhancement System™ consists of multiple **synchronized display units** arranged in precise spatial geometry."],
    h3: ["Structuur en synchronisatie", "Structure et synchronisation", "Structure and synchronization"],
  }]),
  iconCards(i, c, "structure-cards", null, [
    {
      icon: "ees",
      h: ["Exact gepositioneerd", "Positionnement exact", "Precision in structure"],
      t: [
        "Elke unit is zo gepositioneerd en gekalibreerd dat de signalen op elkaar zijn afgestemd en als één coherent geheel samenwerken. Samen genereren ze gestructureerde lichtpatronen en harmonische signaalinteracties doorheen de omringende ruimte.",
        "Chaque unité est positionnée et calibrée de sorte que les signaux s'accordent et fonctionnent comme un tout cohérent. Ensemble, elles génèrent des motifs lumineux structurés et des interactions harmoniques de signaux dans tout l'espace environnant.",
        "Within each structure, the units are positioned and calibrated so that their signals align and interact as a unified whole. Together, these configurations generate structured light patterns and harmonic signal interactions throughout the surrounding space.",
      ],
    },
    {
      icon: "technology",
      h: ["Constructieve interferentie", "Interférence constructive", "Constructive interference"],
      t: [
        "Wanneer signalen gefragmenteerd of ongelijkmatig zijn, ontstaat instabiliteit — in de omgeving en in de systemen die daarin functioneren. Wanneer ze gesynchroniseerd en afgestemd zijn, versterken ze elkaar. In de natuurkunde noemen we dit constructieve interferentie.",
        "Lorsque les signaux sont fragmentés ou irréguliers, une instabilité apparaît — dans l'environnement comme dans les systèmes qui y fonctionnent. Lorsqu'ils sont synchronisés et accordés, ils se renforcent mutuellement. En physique, on parle d'interférence constructive.",
        "When signals are aligned in timing and phase, they reinforce one another rather than interfere, a phenomenon described in physics as constructive interference.",
      ],
    },
    {
      icon: "energy_first",
      h: ["Stabiliteit door synchronisatie", "La stabilité par la synchronisation", "Stability through synchronization"],
      t: ["Door ruimtelijke afstemming en synchronisatie draagt het EESystem bij aan stabiele omgevingscondities.", "Grâce à l'alignement spatial et à la synchronisation, l'EESystem contribue à des conditions ambiantes stables.", "Through precise spatial alignment and synchronization, the system contributes to stable environmental conditions."],
    },
  ]),
  chapter(i, c, "field", [{ p: [[
    "Dit coherente veld werkt niet via kracht. Het werkt via **resonantie** — de natuurlijke neiging van biologische systemen om zich af te stemmen op stabiele externe signalen. Wanneer de omgeving coherent is, volgt het lichaam van nature. Het EESystem is ontworpen om precies die coherentie te scheppen.",
    "Ce champ cohérent n'agit pas par la force. Il agit par **résonance** — la tendance naturelle des systèmes biologiques à s'accorder à des signaux extérieurs stables. Lorsque l'environnement est cohérent, le corps suit naturellement. L'EESystem est conçu pour créer précisément cette cohérence.",
    "The result is a coherent field acting not through force. It operates through **resonance** — the natural tendency of biological systems to attune to stable external signals. When the environment is coherent, the body naturally follows. The EESystem is designed to create precisely that coherence.",
  ]] }]),
  imageText(i, c, "scale", "founders", "left", [{
    h: ["De BEAM-installatie omvat **48 gesynchroniseerde units**.", "L'installation BEAM compte **48 unités synchronisées**.", "The BEAM installation operates with a **48-unit configuration**."],
    h3: ["Schaal en ruimtelijke consistentie", "Échelle et constance spatiale", "Scale and spatial consistency"],
    p: [
      [
        "De BEAM-installatie omvat 48 gesynchroniseerde units, waarmee het behoort tot de grootste coherente EESystem-omgevingen die momenteel actief zijn in Europa. Die schaal vertaalt zich rechtstreeks in een grotere ruimtelijke consistentie en een stabielere energetische omgeving.",
        "L'installation BEAM compte 48 unités synchronisées, ce qui en fait l'un des plus grands environnements EESystem cohérents actuellement en activité en Europe. Cette échelle se traduit directement par une plus grande constance spatiale et un environnement énergétique plus stable.",
        "The BEAM installation operates with a 48-unit configuration. BEAM operates one of the largest coherent EESystem environments currently in Europe. This scale directly translates into greater spatial consistency and a more stable energy environment.",
      ],
      ["Grotere gesynchroniseerde systemen zorgen voor:", "Des systèmes synchronisés plus grands offrent :", "Larger synchronized systems allow for:"],
    ],
    list: [
      ["Grotere ruimtelijke symmetrie", "Une plus grande symétrie spatiale", "Greater spatial symmetry"],
      ["Meer gelijkmatige signaalverdeling", "Une répartition plus homogène des signaux", "More uniform signal distribution"],
      ["Verhoogde consistentie in de hele ruimte", "Une constance accrue dans tout l'espace", "Increased consistency throughout the space"],
    ],
  }, { p: [["Dit zorgt ervoor dat de omgeving stabiel blijft, ongeacht de positie die men in de ruimte inneemt.", "Ainsi, l'environnement reste stable, quelle que soit la place que l'on occupe dans l'espace.", "This ensures that the environment remains stable regardless of position within the room."]] }]),
  chapter(i, c, "science", [{
    h: ["De concepten die ten grondslag liggen aan het EESystem worden onderzocht binnen **gevestigde wetenschappelijke disciplines**", "Les concepts qui sous-tendent l'EESystem sont étudiés au sein de **disciplines scientifiques établies**", "The concepts underlying the EESystem are explored within **established scientific fields**."],
    h3: ["Wetenschappelijke context", "Contexte scientifique", "Scientific context"],
    p: [["Waaronder:", "Notamment :", "Including:"]],
    list: [
      ["Systeembiologie", "La biologie des systèmes", "Systems biology"],
      ["Bio-elektriciteit en cellulaire regulatie", "La bioélectricité et la régulation cellulaire", "Bioelectricity and cellular regulation"],
      ["Neurowetenschap en stressfysiologie", "Les neurosciences et la physiologie du stress", "Neuroscience and stress physiology"],
      ["Fotobiomodulatie en onderzoek naar licht", "La photobiomodulation et la recherche sur la lumière", "Photobiomodulation and light-based research"],
    ],
  }, { p: [COHERENCE_PROCESSES] }]),
  statement(i, c, "coherence-statement", COHERENCE_STATEMENT),
  imageText(i, c, "schrodinger", "space-concepts", "right", [{
    h: ["“Levende systemen behouden interne orde door energie op te nemen uit hun omgeving.”", "« Les systèmes vivants maintiennent leur ordre interne en puisant de l'énergie dans leur environnement. »", "“Living systems maintain order by drawing energy from their environment.”"],
    h3: ["Erwin Schrödinger, Nobelprijswinnaar", "Erwin Schrödinger, lauréat du prix Nobel", "Erwin Schrödinger, Nobel laureate"],
    p: [
      [
        "**Longevity-onderzoek** voegt een verdere dimensie toe. Mitochondriale processen, telomeerbehoud en hartslagvariabiliteit zijn gevestigde markers van biologische leeftijd — en alle drie reageren ze op aanhoudende regulatie van het zenuwstelsel en consistent herstel. Omgevingen die deze omstandigheden ondersteunen, beïnvloeden niet alleen hoe mensen zich vandaag voelen. Ze beïnvloeden hoe ze verouderen.",
        "**Les recherches sur la longévité** ajoutent une dimension supplémentaire. Les processus mitochondriaux, la préservation des télomères et la variabilité de la fréquence cardiaque sont des marqueurs reconnus de l'âge biologique — et tous trois réagissent à une régulation durable du système nerveux et à une récupération régulière. Les environnements qui soutiennent ces conditions n'influencent pas seulement la façon dont les gens se sentent aujourd'hui. Ils influencent la façon dont ils vieillissent.",
        "**Longevity research** adds a further dimension. Mitochondrial function, telomere preservation and heart rate variability are established markers of biological age — all of which respond to sustained nervous system regulation and consistent recovery. Environments that support these conditions do not only influence how people feel today. They influence how they age.",
      ],
      [
        "Aan de basis van al deze disciplines ligt wat Nobelprijswinnaar Erwin Schrödinger heel duidelijk omschreef: levende systemen behouden interne orde door energie uit hun omgeving op te nemen, een principe dat nog steeds van invloed is op de moderne systeembiologie.",
        "À la base de toutes ces disciplines se trouve ce que le lauréat du prix Nobel Erwin Schrödinger a formulé très clairement : les systèmes vivants maintiennent leur ordre interne en puisant de l'énergie dans leur environnement, un principe qui influence encore aujourd'hui la biologie des systèmes moderne.",
        "Underlying all of these fields is a principle that Nobel laureate Erwin Schrödinger articulated as early as 1944: living systems maintain their internal order by continuously drawing energy from their environment. This insight remains one of the foundational ideas of modern systems biology and continues to inform how scientists understand the relationship between environment and biological function.",
      ],
      [
        "Onderzoek naar elektromagnetische omgevings-coherentie is volop in ontwikkeling. Maar dat omgevingsfactoren een directe invloed hebben op biologische regulatie — daarover bestaat geen twijfel.",
        "La recherche sur la cohérence électromagnétique de l'environnement est en plein développement. Mais que les facteurs environnementaux influencent directement la régulation biologique, cela ne fait aucun doute.",
        "While research into environmental electromagnetic coherence remains an evolving area, the broader principle — that environmental conditions directly influence biological regulation — is well established across multiple scientific disciplines.",
      ],
    ],
  }]),
  imageText(i, c, "positioning", "space-system", "left", [{
    h: ["Het **EESystem™** is deel van een **omgevingsarchitectuur**.", "L'**EESystem™** fait partie d'une **architecture environnementale**.", "The **EESystem** is part of an **environmental architecture**."],
    h3: ["Positionering", "Positionnement", "Positioning"],
    p: [[
      "Het Energy Enhancement System™ is geen behandeling en vervangt geen medische zorg. Het maakt deel uit van een omgevingsarchitectuur die is ontworpen om de omstandigheden te scheppen waarin het lichaam zichzelf kan reguleren, herstellen en effectief functioneren.",
      "L'Energy Enhancement System™ n'est pas un traitement et ne remplace pas les soins médicaux. Il fait partie d'une architecture environnementale conçue pour créer les conditions dans lesquelles le corps peut se réguler, récupérer et fonctionner efficacement.",
      "The Energy Enhancement System™ is not a treatment and does not replace medical care. It is part of an environmental architecture designed to support the conditions in which the body can regulate, recover and function effectively.",
    ]],
  }]),
  statement(i, c, "closing", [[
    "Het Energy Enhancement System ondersteunt de omgeving, zodat het lichaam kan doen waartoe het **van nature in staat is**.",
    "L'Energy Enhancement System soutient l'environnement, pour que le corps puisse faire **ce dont il est naturellement capable**.",
    "The Energy Enhancement System supports the environment so the body can do **what it already knows how to do**.",
  ]]),
  faq(i, c, "faq", ["Vragen over de technologie", "Questions sur la technologie", "Questions about the technology"], FAQ_TECH),
  cta(i, c, "cta", ["Ontdek de omgeving", "Découvrez l'environnement", "Discover the environment"], ["Hoe elke ontwerpkeuze van de BEAM-ruimte herstel mogelijk maakt.", "Comment chaque choix de conception de l'espace BEAM rend la récupération possible.", "How every design choice in the BEAM space makes restoration possible."], ["Meer over de omgeving", "En savoir plus", "More about the environment"], c.page("environment")),
];

export const PAGES: Record<string, PageModule> = {
  environment: { build: ENVIRONMENT, media: MEDIA },
  technology: { build: TECHNOLOGY, media: MEDIA },
};
