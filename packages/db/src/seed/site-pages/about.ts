/**
 * Site pages of the "about" group: `about` (beam.be/beam) and `founders` (beam.be/oprichters).
 * Every line of the old pages (docs/research/beam-be/beam.md, en-beam.md, oprichters.md,
 * en-founders.md) is kept: nl and en verbatim, fr translated from the nl. The coverage test
 * `about.coverage.test.ts` fails when a line goes missing.
 */
import { BOOK, cards, chapter, cta, hero, imageText, portal, statement, type Builder, type L3, type MediaSeed, type PageModule } from "../site-kit";

const MEDIA: Record<string, MediaSeed> = {
  "about-banner": { file: "Over-ons-banner-1600-x-400.webp", alt: ["De BEAM-ruimte met bedden, zetels en de EESystem-schermen, doorkruist door een gouden golf", "L'espace BEAM avec ses lits, ses fauteuils et les écrans EESystem, traversé d'une vague dorée", "The BEAM space with beds, armchairs and the EESystem screens, crossed by a gold wave"] },
  "about-community": { file: "BEAM-About-1600-x-500-2.webp", alt: ["Gasten applaudisseren tijdens een event bij BEAM", "Des invités applaudissent lors d'un événement chez BEAM", "Guests applauding at an event at BEAM"] },
  "about-jonathan": { file: "1-1.webp", alt: ["Portret van Jonathan Bossaer, medeoprichter van BEAM", "Portrait de Jonathan Bossaer, cofondateur de BEAM", "Portrait of Jonathan Bossaer, co-founder of BEAM"] },
  "about-sanne": { file: "2-1.webp", alt: ["Portret van Sanne de Regt, medeoprichter van BEAM", "Portrait de Sanne de Regt, cofondatrice de BEAM", "Portrait of Sanne de Regt, co-founder of BEAM"] },
  "about-christophe": { file: "3.webp", alt: ["Portret van Christophe Haddad, medeoprichter van BEAM", "Portrait de Christophe Haddad, cofondateur de BEAM", "Portrait of Christophe Haddad, co-founder of BEAM"] },
};

const QUOTE: L3[] = [
  ["“Wij wilden geen wellnessruimte creëren.", "« Nous ne voulions pas créer un espace de bien-être.", "“We did not set out to create a wellness space."],
  ["We wilden een **structureel tekort** oplossen.”", "Nous voulions combler un **manque structurel**. »", "We set out to correct a **structural gap**.”"],
];

const CTA_HEADING: L3 = ["Ervaar het zelf", "Faites-en l'expérience", "Experience it yourself"];
const CTA_TEXT: L3 = ["De beste manier om BEAM te begrijpen is er te zijn.", "La meilleure façon de comprendre BEAM, c'est d'y être.", "The best way to understand BEAM is to be there."];

const FOUNDERS: { key: string; name: string; img: string; text: L3 }[] = [
  {
    key: "jonathan",
    name: "Jonathan Bossaer",
    img: "about-jonathan",
    text: [
      "Jonathan is ondernemer en strategisch leider met meer dan twintig jaar ervaring. Als oprichter van BRANDEPIC — een studio voor merkarchitectuur gespecialiseerd in de wellnesssector — heeft hij merken ontwikkeld en gepositioneerd voor organisaties door heel Europa. Bij BEAM vertaalt hij die ervaring naar een overtuiging die hem al jaren drijft: menselijke energie is de meest onderbenutte factor in het moderne organisatie- en ondernemingslandschap. Bij BEAM is hij verantwoordelijk voor de strategische koers, investeerder & zakenrelaties en de merkidentiteit van BEAM.",
      "Jonathan est entrepreneur et dirigeant stratégique, fort de plus de vingt ans d'expérience. En tant que fondateur de BRANDEPIC — un studio d'architecture de marque spécialisé dans le secteur du bien-être — il a développé et positionné des marques pour des organisations dans toute l'Europe. Chez BEAM, il traduit cette expérience en une conviction qui l'anime depuis des années : l'énergie humaine est le facteur le plus sous-exploité du paysage organisationnel et entrepreneurial moderne. Chez BEAM, il est responsable de l'orientation stratégique, des relations avec les investisseurs et les partenaires commerciaux, et de l'identité de marque de BEAM.",
      "Jonathan brings over two decades of experience as an entrepreneur and strategic leader. As founder of BrandEpic, a brand architecture studio specialising in the wellness economy, he has developed and positioned brands for organisations across Europe. His work at BEAM reflects a long-standing conviction that human energy is the most underleveraged asset in modern organisational life. Jonathan leads BEAM’s strategic direction, corporate partnerships and brand architecture.",
    ],
  },
  {
    key: "sanne",
    name: "Sanne de Regt",
    img: "about-sanne",
    text: [
      "Sanne specialiseert zich in menselijke ontwikkeling, gedragsdynamiek en het operationele ontwerp van omgevingen die regulatie en herstel ondersteunen. Haar werk vertrekt vanuit een diep begrip van hoe mensen functioneren onder aanhoudende druk en welke omstandigheden werkelijk bijdragen aan herstel. Bij BEAM ontwikkelt ze de gastprogramma’s, is ze het aanspreekpunt van onze community en werkt ze aan de voortdurende verfijning van de ervaring binnen de ruimte.",
      "Sanne est spécialisée dans le développement humain, les dynamiques comportementales et la conception opérationnelle d'environnements qui soutiennent la régulation et la récupération. Son travail repose sur une compréhension profonde de la façon dont les personnes fonctionnent sous une pression prolongée, et des conditions qui contribuent réellement à la récupération. Chez BEAM, elle développe les programmes destinés aux hôtes, elle est l'interlocutrice de notre communauté et elle affine sans cesse l'expérience au sein de l'espace.",
      "Sanne specialises in human development, behavioural dynamics and the operational design of environments that support regulation and recovery. Her work is grounded in a deep understanding of how people function under sustained pressure — and what conditions genuinely support restoration. At BEAM, she leads the development of guest programmes, community engagement and the ongoing refinement of the human experience within the space.",
    ],
  },
  {
    key: "christophe",
    name: "Christophe Haddad",
    img: "about-christophe",
    text: [
      "Christophe verbindt diepgaande kennis van organisatiedynamiek met een uitzonderlijk vermogen om complexe principes om te zetten in concrete ervaring. Hij brengt structuur en creatieve precisie naar het ontwerp en de realisatie van de BEAM-omgeving zodat elk element doordacht en coherent aanvoelt en volledig in lijn is met waar BEAM voor staat. Zijn achtergrond omvat operationeel leiderschap, implementatiestrategie en human-centered design.",
      "Christophe allie une connaissance approfondie des dynamiques organisationnelles à une capacité exceptionnelle à traduire des principes complexes en expérience concrète. Il apporte structure et précision créative à la conception et à la réalisation de l'environnement BEAM, afin que chaque élément soit réfléchi, cohérent et pleinement aligné sur ce que BEAM représente. Son parcours couvre le leadership opérationnel, la stratégie de mise en œuvre et le design centré sur l'humain.",
      "Christophe combines deep expertise in organisational dynamics with an exceptional ability to translate complex principles into lived experience. He brings structured thinking and creative precision to the design and delivery of the BEAM environment — ensuring that every element of the guest experience is intentional, coherent and aligned with BEAM’s founding principles. His background spans operational leadership, implementation strategy and human-centred design.",
    ],
  },
];

/** beam.be/beam: the reality, the perspective, what BEAM is and is not, commitment, beliefs, values, the people and the partners. */
const ABOUT: Builder = (i, c) => [
  hero(i, c, ["Wanneer energie verandert, verandert alles", "Quand l'énergie change, tout change", "When energy changes, everything changes"], ["Over ons", "À propos de nous", "About us"], undefined, "about-banner"),
  imageText(i, c, "reality", "night", "right", [{
    h: ["Menselijke energie is structureel uitgeput.", "L'énergie humaine est structurellement épuisée.", "Human energy is structurally depleted."],
    h3: ["De realiteit waar wij een antwoord op bieden", "La réalité à laquelle nous répondons", "The reality we respond to"],
    p: [
      [
        "Het moderne leven, inclusief de manier waarop we werken, vraagt constant aandacht, belast ons zenuwstelsel en put onze mentale capaciteit uit. We zijn voortdurend ‘verbonden’, hebben weinig tijd om bij te komen en de verwachtingen rond onze prestaties worden steeds hoger, terwijl **onze energetische basis verzwakt**.",
        "La vie moderne, y compris notre façon de travailler, exige une attention constante, sollicite notre système nerveux et épuise nos capacités mentales. Nous sommes en permanence « connectés », nous avons peu de temps pour récupérer et les attentes en matière de performance ne cessent d'augmenter, tandis que **notre base énergétique s'affaiblit**.",
        "Modern life, including the way we work, places continuous demands on our attention, nervous system, and cognitive capacity. We are constantly connected, recovery time is limited, and expectations around performance keep increasing, even as the **energetic foundation weakens**.",
      ],
      [
        "Ondanks ongeziene investeringen in welzijn, veerkracht-programma’s en prestatiegerichte strategieën is de trend duidelijk: burn-out, stressgerelateerd verzuim, een gebrek aan betrokkenheid en afnemende productiviteit blijven bestaan en nemen zelfs toe.",
        "Malgré des investissements sans précédent dans le bien-être, les programmes de résilience et les stratégies axées sur la performance, la tendance est claire : le burn-out, l'absentéisme lié au stress, le manque d'engagement et la baisse de productivité persistent, et augmentent même.",
        "Despite unprecedented investment in wellness, resilience programmes, and performance strategies, the trend is clear: burnout, stress-related absence, disengagement, and declining capacity persist and intensify.",
      ],
      [
        "Het probleem is niet een gebrek aan inspanning. Het probleem is dat de meeste benaderingen energie niet aanpakken **op het niveau waar het werkelijk speelt**. Er ontbreekt iets essentieels en het zit verweven in de systemen waarop we dagelijks vertrouwen. In de manier waarop we werken, communiceren en ons leven inrichten.",
        "Le problème n'est pas un manque d'effort. Le problème, c'est que la plupart des approches ne traitent pas l'énergie **au niveau où elle se joue réellement**. Il manque quelque chose d'essentiel, et cela est ancré dans les systèmes sur lesquels nous comptons chaque jour. Dans notre façon de travailler, de communiquer et d'organiser notre vie.",
        "The problem is not a lack of effort. The problem is that most approaches do not address energy **at the level where it operates**. In other words, something essential is missing. And it is embedded in the systems we rely on — in how we work, communicate, and organise modern life.",
      ],
    ],
  }]),
  chapter(i, c, "perspective", [
    {
      h: ["BEAM keert terug naar de basis: **energie zelf**.", "BEAM revient à l'essentiel : **l'énergie elle-même**.", "BEAM operates at the foundational layer: **energy itself**."],
      h3: ["Ons perspectief", "Notre regard", "Our perspective"],
      list: [
        ["De meeste interventies richten zich op symptomen.", "La plupart des interventions s'attaquent aux symptômes.", "Most interventions address symptoms."],
        ["De meeste welzijns-programma’s focussen op coping.", "La plupart des programmes de bien-être visent à mieux faire face.", "Most wellness focuses on coping."],
        ["De meeste prestatie-strategieën zijn gericht op het verhogen van de output.", "La plupart des stratégies de performance cherchent à augmenter le rendement.", "Most performance strategies push output."],
      ],
    },
    {
      p: [
        [
          "Energie, niet als concept of metafoor, maar als de basis die bepaalt hoe mensen functioneren, herstellen en hun potentieel op de lange termijn behouden.",
          "L'énergie, non pas comme concept ou métaphore, mais comme la base qui détermine la façon dont les gens fonctionnent, récupèrent et préservent leur potentiel sur le long terme.",
          "Energy, not as a concept or metaphor, but as the layer that determines how people function, recover, and sustain their potential over time.",
        ],
        [
          "Dit is een inzicht op systeemniveau. In plaats van symptomen te bestrijden of snelle oplossingen aan te reiken, richt BEAM zich op het creëren van **de juiste omgeving** waarin herstel vanzelf kan plaatsvinden.",
          "C'est une vision à l'échelle du système. Plutôt que de combattre les symptômes ou de proposer des solutions rapides, BEAM se concentre sur la création de **l'environnement adéquat**, dans lequel la récupération peut se faire d'elle-même.",
          "This is not spiritual abstraction. This insight applies at the system level. Rather than addressing symptoms or offering quick fixes, BEAM focuses on creating the **right environment** for restoration to occur naturally.",
        ],
      ],
    },
  ]),
  chapter(i, c, "foundation", [{
    h: ["BEAM is een fundament voor **menselijke energie**.", "BEAM est une fondation pour l'**énergie humaine**.", "BEAM is an infrastructure for **human energy**."],
    h3: ["Wat BEAM is", "Ce qu'est BEAM", "What BEAM is"],
    p: [
      [
        "Wij creëren ruimtes die zijn ontworpen om coherentie, regulatie en herstel te bevorderen, zodat het lichaam en het zenuwstelsel kunnen doen waar ze van nature toe in staat zijn als de juiste voorwaarden vervuld zijn.",
        "Nous créons des espaces conçus pour favoriser la cohérence, la régulation et la récupération, afin que le corps et le système nerveux puissent faire ce dont ils sont naturellement capables lorsque les bonnes conditions sont réunies.",
        "We create environments designed to support coherence, regulation, and restoration, allowing the body and nervous system to do what they are inherently capable of when the right conditions are present.",
      ],
      [
        "Wanneer de regulatie zich stabiliseert, volgt herstel vanzelf. En vanuit herstel keert de capaciteit automatisch terug.",
        "Quand la régulation se stabilise, la récupération suit d'elle-même. Et avec la récupération, la capacité revient automatiquement.",
        "When regulation stabilises, recovery follows naturally — and from recovery, capacity returns.",
      ],
      [
        "**Energie is de basis waarop helderheid, veerkracht en duurzame prestaties worden gebouwd.**",
        "**L'énergie est la base sur laquelle se construisent la clarté, la résilience et la performance durable.**",
        "**Energy is the foundation on which clarity, resilience, and sustained performance are built.**",
      ],
    ],
  }]),
  chapter(i, c, "not", [{
    h: ["Wat BEAM niet is", "Ce que BEAM n'est pas", "What BEAM is not"],
    list: [
      ["BEAM is geen wellness-extraatje.", "BEAM n'est pas un supplément bien-être.", "BEAM is not a wellness add-on."],
      ["BEAM is geen productiviteitstool.", "BEAM n'est pas un outil de productivité.", "BEAM is not a productivity tool."],
      ["BEAM is geen therapie of coaching.", "BEAM n'est ni une thérapie ni du coaching.", "BEAM is not therapy or coaching."],
    ],
  }, {
    p: [[
      "Deze benaderingen hebben hun waarde, maar ze grijpen pas in op een later stadium, wanneer de capaciteit al onder druk staat.",
      "Ces approches ont leur valeur, mais elles n'interviennent qu'à un stade ultérieur, lorsque la capacité est déjà sous pression.",
      "These approaches can be valuable, but they operate downstream, once capacity is already under strain.",
    ]],
  }]),
  statement(i, c, "statement-upstream", [[
    "**BEAM is actief in een vroeger stadium**, door de omstandigheden te creëren waarin de capaciteit zich vanzelf kan herstellen.",
    "**BEAM agit à un stade plus précoce**, en créant les conditions dans lesquelles la capacité peut se rétablir d'elle-même.",
    "**BEAM operates upstream**, by providing the conditions that allow capacity to restore naturally.",
  ]]),
  cards(i, c, "vision-mission", null, [
    {
      h: ["Onze visie", "Notre vision", "Our vision"],
      t: [
        "Een wereld waarin mensen en organisaties hun potentieel waarmaken door met menselijke energie mee te bewegen, in plaats van ertegenin te gaan.",
        "Un monde où les personnes et les organisations réalisent leur potentiel en accompagnant l'énergie humaine, plutôt qu'en allant à son encontre.",
        "A world in which people and organisations sustain their potential by working with, rather than against, human energy.",
      ],
    },
    {
      h: ["Onze missie", "Notre mission", "Our mission"],
      t: [
        "Wij creëren coherente ruimtes die vitaliteit vanuit de basis ondersteunen en mensen en organisaties terugbrengen naar hun natuurlijke capaciteit.",
        "Nous créons des espaces cohérents qui soutiennent la vitalité à la base et ramènent les personnes et les organisations à leur capacité naturelle.",
        "We create coherent environments that restore vitality and enable people and organisations to operate at their natural capacity.",
      ],
    },
  ]),
  imageText(i, c, "commitment", "about-community", "left", [{
    h: ["We streven ernaar een omgeving te creëren die wordt gedragen met **zorg**, **respect** en **aanwezigheid**.", "Nous nous efforçons de créer un environnement porté par la **bienveillance**, le **respect** et la **présence**.", "At BEAM, we commit to creating a space defined by **care**, **respect** and **presence**."],
    h3: ["Ons engagement", "Notre engagement", "Our commitment"],
    p: [
      [
        "BEAM is er om herstel te ondersteunen, niet om mensen verder te pushen. Hier wordt niet gevraagd om méér te doen, maar krijg je de ruimte om weer verbinding te maken met wat er al is.",
        "BEAM est là pour soutenir la récupération, pas pour pousser les gens plus loin. Ici, on ne vous demande pas d'en faire plus : vous recevez l'espace pour renouer avec ce qui est déjà là.",
        "BEAM exists to support restoration, not to push people beyond themselves. Here, people are not asked to do more, but are given the space to reconnect with what is already there.",
      ],
      ["Wij verbinden ons ertoe om:", "Nous nous engageons à :", "We commit to:"],
    ],
    list: [
      ["Een rustige, veilige en professionele ruimte te bieden waar diepe ontspanning mogelijk is.", "Offrir un espace calme, sûr et professionnel où une détente profonde est possible.", "Providing a calm, safe, and professional environment where deep relaxation is possible."],
      ["Mensen uit te nodigen om helemaal te zijn zoals ze zijn. Zonder verwachtingen, zonder dat ze iets hoeven te presteren en zonder oordeel.", "Inviter chacun à être pleinement tel qu'il est. Sans attentes, sans rien devoir accomplir et sans jugement.", "Allowing people to arrive exactly as they are — without expectation, performance, or judgement."],
      ["Elke gast te behandelen met oprechte zorg, aandacht en respect.", "Traiter chaque hôte avec une bienveillance, une attention et un respect sincères.", "Treating every guest with genuine care, attentiveness, and respect."],
      ["Een niet-invasieve, niet-medische omgeving te bieden die gericht is op herstel in plaats van interventie.", "Offrir un environnement non invasif et non médical, axé sur la récupération plutôt que sur l'intervention.", "Offering a non-invasive, non-medical setting that supports restoration rather than intervention."],
      ["Integer, consistent en discreet te zijn in alles wat we doen.", "Faire preuve d'intégrité, de constance et de discrétion dans tout ce que nous faisons.", "Holding integrity, consistency and discretion in how we work."],
    ],
  }]),
  chapter(i, c, "beliefs", [{
    h: ["Vijf krachtige benaderingen liggen aan de grondslag van **elke keuze die we maken**.", "Cinq approches fortes sont à la base de **chacun de nos choix**.", "These beliefs **guide every choice we make**."],
    h3: ["De basis waarop BEAM is gebouwd", "Les fondements de BEAM", "Our beliefs"],
    p: [[
      "Van hoe we onze ruimtes inrichten tot de manier waarop onze gasten worden verwelkomd en begeleid.",
      "De l'aménagement de nos espaces à la manière dont nos hôtes sont accueillis et accompagnés.",
      "From how our spaces are designed to how people are welcomed and held. We believe that:",
    ]],
  }]),
  cards(i, c, "beliefs-list", null, [
    { h: ["Het menselijk systeem is intelligent en kan zichzelf reguleren wanneer de juiste voorwaarden aanwezig zijn.", "Le système humain est intelligent et peut s'autoréguler lorsque les bonnes conditions sont réunies.", "The human system is intelligent and self-regulating when the right conditions are present."], t: ["", "", ""] },
    { h: ["Energie vormt de basis voor helderheid, veerkracht en duurzame prestaties.", "L'énergie est la base de la clarté, de la résilience et de la performance durable.", "Energy is foundational to clarity, resilience, and sustainable performance."], t: ["", "", ""] },
    { h: ["Duurzame capaciteit ontstaat door herstel, niet door druk.", "Une capacité durable naît de la récupération, pas de la pression.", "Long-term capacity is built through restoration, not pressure."], t: ["", "", ""] },
    { h: ["Rust en consistentie zijn krachtiger dan intensiteit en forceren.", "Le calme et la constance sont plus puissants que l'intensité et la contrainte.", "Calm and consistency are more powerful than intensity and force."], t: ["", "", ""] },
    { h: ["Echte ondersteuning werkt met het lichaam mee, niet ertegenin.", "Un vrai soutien travaille avec le corps, pas contre lui.", "True support works with the body, not against it."], t: ["", "", ""] },
  ], "list"),
  cards(i, c, "values", ["Onze waarden", "Nos valeurs", "Our values"], [
    {
      h: ["Eerbied", "Respect profond", "Reverence"],
      t: [
        "Wij hebben diep respect voor de intelligentie van het menselijk systeem. Iedereen die BEAM binnenkomt, wordt ontvangen met waardigheid, zorgzaamheid en vertrouwen in het inherente vermogen van het lichaam om zichzelf te herstellen.",
        "Nous avons un profond respect pour l'intelligence du système humain. Toute personne qui entre chez BEAM est accueillie avec dignité, bienveillance et confiance dans la capacité inhérente du corps à se rétablir.",
        "We hold deep respect for the intelligence of the human system. We do not seek to override it, but to support it. Every person who enters BEAM is met with dignity, care and trust in the body’s inherent capacity.",
      ],
    },
    {
      h: ["Verantwoord beheer", "Gestion responsable", "Stewardship"],
      t: [
        "Wij nemen verantwoordelijkheid op voor de ruimtes die we creëren en de impact die we teweegbrengen. Ons werk wordt gekenmerkt door integriteit, verantwoordelijkheid en langetermijndenken, zowel ten aanzien van individuen en organisaties als de bredere samenleving.",
        "Nous assumons la responsabilité des espaces que nous créons et de l'impact que nous générons. Notre travail se caractérise par l'intégrité, la responsabilité et une vision à long terme, envers les personnes et les organisations comme envers la société dans son ensemble.",
        "We take responsibility for the spaces we create and the impact we generate. Our work is guided by integrity, accountability and long-term thinking — toward individuals, organisations and the wider community.",
      ],
    },
    {
      h: ["Aanwezigheid", "Présence", "Presence"],
      t: [
        "Echte ondersteuning begint met er volledig te zijn. Niet half. Niet gehaast. Maar werkelijk aanwezig. Bij het moment, bij de persoon, bij wat er nodig is. Bij BEAM is aandacht niet versnipperd en tijd niet schaars. Hier krijgt elke persoon de ruimte die ze verdient.",
        "Un vrai soutien commence par être pleinement là. Pas à moitié. Pas dans la précipitation. Mais réellement présent. Au moment, à la personne, à ce qui est nécessaire. Chez BEAM, l'attention n'est pas dispersée et le temps n'est pas compté. Ici, chaque personne reçoit l'espace qu'elle mérite.",
        "True support begins with presence. Attentive. Unhurried. Fully engaged with the moment and the person in front of us. We create environments where attention is not fragmented and time is not rushed.",
      ],
    },
    {
      h: ["Flow", "Fluidité", "Flow"],
      t: [
        "We verkiezen afstemming boven kracht en ritme boven druk. Wanneer iets wringt, dan klopt de richting niet. Bij BEAM laten we energie haar eigen weg vinden. Niet door te sturen, maar door de juiste omstandigheden te scheppen waarin ze vanzelf stroomt.",
        "Nous préférons l'harmonie à la force et le rythme à la pression. Quand quelque chose coince, c'est que la direction n'est pas la bonne. Chez BEAM, nous laissons l'énergie trouver son propre chemin. Non pas en la dirigeant, mais en créant les bonnes conditions pour qu'elle circule d'elle-même.",
        "We value alignment over force and rhythm over pressure. If something requires strain, it is not aligned. We move with coherence, allowing energy to organise naturally rather than imposing control.",
      ],
    },
    {
      h: ["Overvloed", "Abondance", "Abundance"],
      t: [
        "Wij werken vanuit vertrouwen in plaats van schaarste. Wanneer energie wordt ondersteund en systemen op elkaar zijn afgestemd, ontstaan groei en vitaliteit vanzelf.",
        "Nous agissons dans la confiance plutôt que dans la rareté. Quand l'énergie est soutenue et que les systèmes sont harmonisés, la croissance et la vitalité naissent d'elles-mêmes.",
        "We operate from trust rather than scarcity. When energy is supported and systems are coherent, growth and vitality unfold without force. We choose generosity, openness and long-term vision.",
      ],
    },
  ]),
  statement(i, c, "statement-quote", QUOTE),
  chapter(i, c, "people", [{
    h: ["De mensen achter BEAM", "Les personnes derrière BEAM", "The people behind BEAM"],
    p: [
      ["BEAM werd opgericht door **Jonathan Bossaer, Christophe Haddad en Sanne de Regt**.", "BEAM a été fondé par **Jonathan Bossaer, Christophe Haddad et Sanne de Regt**.", "BEAM was founded by **Jonathan Bossaer, Christophe Haddad and Sanne de Regt**."],
      [
        "Met hun achtergrond in ondernemerschap, organisatieontwikkeling en menselijke prestaties delen zij een gemeenschappelijk inzicht: **duurzame prestaties zijn afhankelijk van duurzame energie**.",
        "Forts de leur expérience dans l'entrepreneuriat, le développement organisationnel et la performance humaine, ils partagent une même conviction : **une performance durable dépend d'une énergie durable**.",
        "With backgrounds in entrepreneurship, organisational development and human performance, the founders share a common insight: **sustainable performance depends on sustainable energy**.",
      ],
      [
        "Hun gecombineerde ervaring omvat bedrijfsstrategie, systeemdenken en het ontwerpen van impactvolle ruimtes. BEAM weerspiegelt de toewijding van de oprichters aan het bouwen van een omgeving die de vitaliteit van mensen fundamenteel ondersteunt.",
        "Leur expérience combinée couvre la stratégie d'entreprise, la pensée systémique et la conception d'espaces à fort impact. BEAM reflète l'engagement des fondateurs à bâtir un environnement qui soutient fondamentalement la vitalité des personnes.",
        "Their combined experience spans business strategy, systems thinking and the design of high-impact environments. BEAM reflects their commitment to building infrastructure that supports human vitality at its foundation.",
      ],
    ],
  }]),
  cards(i, c, "founders", null, FOUNDERS.map((f) => ({ h: [f.name, f.name, f.name] as L3, t: ["", "", ""] as L3, img: f.img, link: c.page("founders") }))),
  chapter(i, c, "partners", [{
    h: ["BEAM werkt samen met organisaties die net als wij **streven naar coherentie, kwaliteit en impact op de lange termijn**.", "BEAM collabore avec des organisations qui, comme nous, **visent la cohérence, la qualité et un impact à long terme**.", "BEAM works alongside organisations that share a **commitment to coherence, quality and long-term impact**."],
    h3: ["Partnerships en affiliates", "Partenariats et affiliations", "Partnerships & affiliations"],
    p: [[
      "Onze partnerships zijn bewust gekozen. We werken samen met partners die begrijpen dat duurzame vitaliteit afhangt van de omgevingen en relaties die we samen creëren.",
      "Nos partenariats sont choisis en connaissance de cause. Nous travaillons avec des partenaires qui comprennent qu'une vitalité durable dépend des environnements et des relations que nous créons ensemble.",
      "Our partnerships are intentional. We collaborate with those who understand that sustainable vitality depends on the environments and relationships we build together.",
    ]],
  }]),
  cta(i, c, "cta", CTA_HEADING, CTA_TEXT, BOOK, portal("book_day")),
];

/** beam.be/oprichters: the three founders, each portrait beside their story. */
const FOUNDERS_PAGE: Builder = (i, c) => [
  statement(i, c, "statement-quote", QUOTE),
  ...FOUNDERS.map((f, n) => imageText(i, c, f.key, f.img, n % 2 ? "right" : "left", [{ h: [f.name, f.name, f.name], p: [f.text] }])),
  cta(i, c, "cta", CTA_HEADING, CTA_TEXT, BOOK, portal("book_day")),
];

export const PAGES: Record<string, PageModule> = {
  about: { build: ABOUT, media: MEDIA },
  founders: {
    build: FOUNDERS_PAGE,
    meta: {
      slug: "founders",
      kind: "standard",
      title: ["Oprichters", "Les fondateurs", "Founders"],
      path: ["oprichters", "fondateurs", "founders"],
      description: [
        "Maak kennis met de oprichters van BEAM Vitality Center: Jonathan Bossaer, Sanne de Regt en Christophe Haddad.",
        "Faites connaissance avec les fondateurs du BEAM Vitality Center : Jonathan Bossaer, Sanne de Regt et Christophe Haddad.",
        "Meet the founders of BEAM Vitality Center: Jonathan Bossaer, Sanne de Regt and Christophe Haddad.",
      ],
    },
  },
};
