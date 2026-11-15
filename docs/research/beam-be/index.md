---
source: https://beam.be (www.beam.be redirects here)
captured: 2026-11-15
platform: WordPress + Elementor / Elementor Pro 4.4 (mix of classic widgets and v4 "atomic" elements), theme hello-elementor, WPML (NL/EN), Rank Math SEO
pages: 58 (37 NL, 21 EN) - every URL in https://beam.be/page-sitemap.xml
---

# beam.be content capture - index

One Markdown file per page sits next to this file, named after the URL path (`/` = `home.md`, `/en/` = `en-home.md`, `/en/sessions/` = `en-sessions.md`). Each file has front-matter (url, lang, title, description, translations, og_image), the page content in reading order, and at the end the image list, the CSS background images, the external/booking links and the popups.

Notes on how to read the page files:
- `**[HIDDEN ON LIVE SITE (display:none) - start]** ... end` means the block is in the HTML but hidden by CSS. These are mostly expired promotions: the anniversary prices on `sessies`/`en-sessions` (valid until 22 August) and early-bird blocks on the concert pages.
- `**[Form: ...]**` lists the form fields and the submit label. The forms were not submitted.
- `[Embed: ...]` / `[Embedded iframe ...]` mark third-party widgets (WebinarGeek, Typeform, ticket shop, Google Maps).
- `[Video: url]` is a YouTube video (classic or atomic Elementor widget).
- `popup:1871` / `popup:1978` are Elementor popup triggers. Their content is below under "Popups".
- Elementor desktop/mobile duplicate blocks were removed. Mobile-only copies are skipped.

## Languages

- **NL** (default, x-default), at the root: 37 pages.
- **EN** under `/en/`: 21 pages. The switcher is a WPML flag ("Overschakelen naar EN" / "Switch to NL").
- **No FR version exists**: no hreflang fr, no /fr/ URLs in the sitemap.
- 16 NL pages have no EN version (campaign, landing and corporate pages, see the tree).
- `/en/home/` 301-redirects to `/en/`, so it is captured as `en-home.md`.
- `/en/sessions/` still has the Dutch `<title>`. `/en/lezing-met-live-the-connection/` still has a Dutch slug.

## Sitemap tree

```
/ (home.md)                                   EN: /en/ (en-home.md)
├── beam/  "BEAM" (over ons)                  EN: /en/beam/
│   ├── oprichters/  Founders                 EN: /en/founders/
│   └── partners/                             EN: /en/partners/
├── omgeving/  Environment                    EN: /en/environment/
├── technologie/  Technology                  EN: /en/technology/
├── sessies/  Sessions + prices (#prijzen)    EN: /en/sessions/
│   └── membership/                           EN: /en/membership/
├── events/  (upcoming + past, paginated)     EN: /en/events/
│   ├── beam-internationale-concertreeks-amber-haddad-band/   (NL only)
│   ├── beam-internationale-concertreeks-alexander-mercks/    EN: /en/beam-international-concert-series-alexander-mercks/
│   ├── beam-internationale-concertreeks-praful/              EN: /en/beam-international-concert-series-praful/
│   ├── webinar-je-systeem-is-uit-balans/     (NL only, WebinarGeek)
│   ├── webinar-je-systeem-is-uit-balans-2/   (NL only, "dankjewel" + WebinarGeek)
│   ├── webinar-je-bent-niet-moe/             (NL only, WebinarGeek)
│   ├── lezing-met-live-the-connection/       EN: /en/lezing-met-live-the-connection/
│   │   ├── bevestiging-van-de-lezing-beam-x-live-the-connection/          (confirmation, NL only)
│   │   └── bevestiging-van-de-online-lezing-beam-x-live-the-connection/   (confirmation, NL only)
│   └── lezing-9-december-wat-als-2027-begint-met-een-volle-batterij/      (NL only, own landing layout, no site header)
├── ervaringen/  Experiences / reviews        EN: /en/experiences/
├── contact/                                  EN: /en/contact/
├── bedrijven/  Corporates (header button)    EN: /en/corporates/
├── faq/                                      EN: /en/faq/
├── blog/  (empty: "nothing found")           EN: /en/blog/ (empty)
├── algemene-voorwaarden/                     EN: /en/terms-and-conditions/
├── privacybeleid/                            EN: /en/privacy-policy/
├── disclaimer/                               EN: /en/disclaimer/
│
├── Corporate funnel (not in nav, NL only)
│   └── corporate/
│       ├── discovery-experience/
│       ├── corporate-reset-day/
│       └── corporate-venue/
├── Campaign / landing pages (not in nav, NL only)
│   ├── ervaar-beam/            first visit offer (EUR 90 instead of 120) + webinar CTA
│   ├── eerste-beam-ervaring/   post-webinar offer (EUR 60, 2 for EUR 100)
│   ├── beam-reviews/           reviews + Google Maps embed
│   ├── meer-informatie/        "BEAM informeert je graag!" (minimal header)
│   └── informatie-ontvangen/   Typeform questionnaire
└── Guest info after booking (not in nav)
    └── horeca/  "Bedankt voor je reservering!" (location, space, house rules, preparation)   EN: /en/hospitality/
```

Blog/news: `/blog/` and `/en/blog/` are Elementor loop grids that show "nothing found". There is no post sitemap and `/wp-json/wp/v2/posts` returns `[]`, so the site has **no blog posts**.
Events: the past-events grid has 8 pages ("Meer laden" / load more). Pages 2-8 were fetched via `?e-page-6ae07a4=N` and added to `events.md` / `en-events.md`.

## Main navigation (header)

The logo (links to home) is followed by these items:

| NL | URL | EN | URL |
|---|---|---|---|
| BEAM | /beam/ | BEAM | /en/beam/ |
| Omgeving | /omgeving/ | Environment | /en/environment/ |
| Technologie | /technologie/ | Technology | /en/technology/ |
| Sessies (submenu: Membership /membership/) | /sessies/ | Sessions (submenu: Membership /en/membership/) | /en/sessions/ |
| Events | /events/ | Events | /en/events/ |
| Ervaringen | /ervaringen/ | Experiences | /en/experiences/ |
| Contact | /contact/ | Contact | /en/contact/ |
| **Button:** Bedrijven | /bedrijven/ | **Button:** Corporates | /en/corporates/ |
| Language flag: EN | /en/ | Language flag: NL | / |

Mobile: an off-canvas menu with the same items, plus a CTA "Boek je sessie" (EN "Book your session") linking to https://book.beam.be/v2/#book.

## Footer

The NL footer is Elementor template 42 and the EN footer is template 1954.

1. Tagline "Your energy. Your life." (also on NL) and CTA **Boek je sessie** / **Book your session** linking to https://book.beam.be/v2/#book
2. Footer logo (`Footer-Logo-SVG-Transparent.svg`) with the blurb: NL "BEAM Vitality Center is een fundament voor menselijke energie. Wij creëren coherente ruimtes die regulatie, herstel en duurzame vitaliteit ondersteunen." / EN "BEAM Vitality Center is an infrastructure for human energy. We create coherent environments designed to support regulation, recovery and sustained vitality."
3. Newsletter, "Abonneer je op onze nieuwsbrief voor updates": an Elementor form with 2 unlabeled text fields (probably first name / last name), Email (required) and the button "Abonneer" / "Subscribe". No Mailchimp or other ESP is visible in the front-end, so the integration is server-side and unknown.
4. **Ontdek / Explore**: Membership, FAQ, Blog, Oprichters/Founders, Partners
5. **Juridisch / Legal**: Algemene voorwaarden / Terms and conditions, Privacybeleid / Privacy policy, Disclaimer
6. Contact block: welcome@beam.be · +32 9 39 12 422 (9u tot 19u) · +32 469 41 31 11 (Whatsapp) · Vibrant Lifestyle Collective BV, Xavier de Cocklaan 70, bus 7, 9831 Sint-Martens-Latem, België · BTW BE0805085449
7. Social icons: Facebook, Instagram, X, LinkedIn, YouTube, WhatsApp
8. "©2026 BEAM Vitality Center. Alle rechten voorbehouden. Ontwikkeld door BRANDEPIC (https://www.brandepic.com)", followed by "Trots lid van Energy Enhancement System™" with the EES logo, linking to https://www.eesystem.com/

## Popups (loaded site-wide, outdated content)

- **1871 (NL)**: "BEAM wordt 2 jaar 🎉 / Onze sterkste aanbieding van 2026. / Kom opladen in ons prachtige centrum en geef jezelf de rust, energie en vitaliteit die je verdient. / Onze uitzonderlijke jubileumaanbieding is geldig tot en met **zaterdag 22 augustus om middernacht**." The button "Ontdek het jubileumaanbod" links to /sessies#prijzen.
- **1978 (EN)**: "BEAM is turning 2 🎉 / Our Best Offer of 2026. / ... valid through **Saturday, August 22, at midnight**." The button "Discover the anniversary offer" links to /en/sessions/#prijzen.

The offer has expired, and the matching discounted price tabs are hidden on `sessies`/`en-sessions`.

## Services and prices

All prices are in EUR incl. VAT. The base rate is **€60 per hour**, and a standard session lasts 2 hours. Booking runs through SimplyBook.me at book.beam.be.

### Sessions (from `sessies.md`, the visible price tabs)

| Service | Price | Note | Booking link |
|---|---|---|---|
| 2 uur dagsessie (volwassenen) | €120 | standard price, €60/h | https://book.beam.be/v2/#book/service/2 |
| 2 uur dagsessie (jongeren 12-18) | €60 | with an adult, €30/h | https://book.beam.be/v2/#book/service/19 |
| 2 uur dagsessie (kinderen < 12) | Gratis | with an adult | https://book.beam.be/v2/#book/service/18 |
| Nachtsessie volwassenen (12 h, single mattress) | €420 | €35/h, "bespaar €300" | https://book.beam.be/v2/#book/service/14 |
| Nachtsessie jongeren 12-18 | €210 | €17.50/h | https://book.beam.be/v2/#book/service/23 |
| Nachtsessie kinderen < 12 | Gratis | | https://book.beam.be/v2/#book/service/22 |
| Pakket 3 nachtsessies | €1260 | €35/h | https://book.beam.be/v2/#packages/24 |
| Pakket 5 nachtsessies (ribbon "Populair") | €1860 | €31/h | https://book.beam.be/v2/#packages/13 |
| Pakket 10 nachtsessies | €3240 | €27/h | https://book.beam.be/v2/#packages/14 |
| 10 uren pakket (5 x 2 h day sessions) | €495 | €49.50/h | https://book.beam.be/v2/#packages/5 |
| 20 uren pakket (ribbon "Populair") | €890 | €44.50/h | https://book.beam.be/v2/#packages/6 |
| 30 uren pakket | €1260 | €42/h | https://book.beam.be/v2/#packages/8 |
| 50 uren pakket | €1850 | €37/h | https://book.beam.be/v2/#packages/9 |
| 100 uren pakket | €3300 | €33/h | https://book.beam.be/v2/#packages/10 |
| Huisdier (Monday 16-18 session only) | €20 per pet | | |

Session and package rules:
- Packages can be shared by up to 5 people and stay valid for 18 months.
- Children under 12 come free with at least one parent. Young people aged 12-18 get 50% off.
- Two consecutive day sessions include the hour in between for free.
- Rescheduling within 24 h costs a €20 administrative fee (see the T&C).
- Capacity is up to 14 people per day session and up to 8 per night session (FAQ).

The hidden anniversary price set (expired) is still in the HTML: day adult €108, 10 h €439, 20 h €739, 30 h €1029, 50 h €1449, 100 h €2399, night adult €375, 3/5/10 nights €1029/€1529/€2519 including breakfasts at Auberge du Pêcheur.

### Membership (`membership.md`)

- **BEAM Membership: €396 per year.** It includes:
  - one free night session or four day sessions (worth €420)
  - up to 20% off sessions and packages
  - 15% off products and events
  - 30% off detox salt
  - 2 members-only gatherings per year
  - a monthly draw for a free night session
- It comes with a numbered physical card. Sign up at https://book.beam.be/v2/#products

### Offers and landing pages

- `ervaar-beam`: first BEAM experience for **€90 instead of €120** (https://book.beam.be/v2/#book/service/69). Its FAQ still mentions "de aanbieding van €60".
- `eerste-beam-ervaring`: webinar offer of **€60 instead of €120**, or **2 for €100 instead of €240** (https://book.beam.be/v2/#book/provider/31). The page says it is valid until Friday midnight.

### Events (`events.md`)

- Webinar "Je bent niet moe. Je systeem is uit balans.": free, online via WebinarGeek, recurring (next on 25 Nov 2026, 18:30-19:30).
- Concert series "Internationale concertreeks":
  - Amber Haddad & Band, 5 Dec 2026, 20:00-22:00: standard €59 (early bird €49), premium €99 (early bird €89).
  - Alexander Mercks (31 Oct 2026) and Praful (19 Sep 2026), both past: €75 standard / €145 premium. Premium includes an extra BEAM session worth €120.
  - Tickets are sold through the ikbenaanwezig.nl shop iframe.
- Lecture "Lezing met Live The Connection" (Marina Riemslagh): €20. It can be booked live or online through SimplyBook (#book/service/58 and #book-class/service/50).
- Lecture "Wat als 2027 begint met een volle batterij?": Wed 9 Dec 2026, 19:30-21:30, at Auberge du Pêcheur. Early bird €15 until 30 Nov, then €20, with a drink and snack included. Tickets through the ikbenaanwezig.nl iframe.
- Other past events are listed in `events.md` (documentary live stream "The Energy that Heals", the 2nd anniversary, LTC lecture in Brecht, and more).

### Corporate (no prices; "op aanvraag", CTA: Calendly intro call)

- `bedrijven` / `en-corporates`: overview for organisations.
- `corporate` → **BEAM Discovery Experience** (`discovery-experience`), **Corporate Reset Day** (`corporate-reset-day`: lectures by Marina Riemslagh and Jonathan Bossaer, workshop, breakfast/lunch, 5 h in the BEAM space) and **BEAM Corporate Venue** (`corporate-venue`: exclusive hire for team days, offsites, keynotes, HR events; projection and sound system).
- Private sessions and group bookings are available on request (contact).

## Contact details and opening hours

- **Business name**: BEAM Vitality Center, operated by Vibrant Lifestyle Collective BV. BTW/VAT BE0805085449.
- **Address**: Xavier de Cocklaan 70, bus 7, 9831 Sint-Martens-Latem, Belgium. It is in the Latem Business Park, 1st floor. Coming from Ghent it is the 2nd block, at the very back; take the lift and ring "BEAM Vitality Center". Directions, parking and public transport are in `horeca.md`.
- **Phone**: +32 9 39 12 422 (9u-19u). WhatsApp: +32 469 41 31 11 (https://wa.me/+32469413111). The FAQ gives 0469 41 31 11 "tussen 9u30 en 18u30".
- **Email**: welcome@beam.be. The contact page promises a reply within 48 h.
- **Contact form** (`contact.md`): Voornaam*, Achternaam, E-mail*, Bericht*, and the button "Stuur bericht".
- **Social**:
  - https://www.facebook.com/beamvitalitycenter
  - https://www.instagram.com/beamvitalitycenter
  - https://x.com/beamvitality
  - https://www.linkedin.com/company/beamvitalitycenter
  - https://www.youtube.com/@beamvitalitycenter
- **Google reviews**: "UITSTEKEND - gebaseerd op 145 recensies" (Trustindex widget). `ervaringen` says "142 geverifieerde vijfsterren reviews".
- **Opened**: June 2024 (membership page).

### Opening hours (sessions, from `sessies.md`)

| Day | 10-12 | 13-15 | 16-18 | Night 20:00-08:00 |
|---|---|---|---|---|
| Maandag | ✓ | ✓ | ✓ (pets welcome) | closed |
| Dinsdag | closed | closed | closed | closed |
| Woensdag | closed | closed | closed | ✓ |
| Donderdag | ✓ | ✓ | ✓ | ✓ |
| Vrijdag | ✓ | ✓ | ✓ | ✓ |
| Zaterdag | ✓ | ✓ (children's session 🧒) | ✓ | ✓ |
| Zondag | ✓ | ✓ | ✓ | ✓ |

Day sessions run "daily except Tuesday and Wednesday", and night sessions run Wednesday to Sunday.

## Team (from `oprichters.md` / `beam.md`)

- **Jonathan Bossaer**: founder of BRANDEPIC. Responsible for strategy, investor and business relations, and brand identity.
- **Sanne de Regt**: guest programmes, community contact, and refinement of the experience.
- **Christophe Haddad**: design and realisation of the BEAM environment. Background in operations, implementation and human-centred design.

Partners (`partners.md`): Energy Enhancement System (eesystem.com, Dr. Sandra Rose Michael), Live The Connection (Dr. Marina Riemslagh, livetheconnection.com), BRANDEPIC (brandepic.com), Auberge du Pêcheur (auberge-du-pecheur.be) and Joie de Vivre Expo (jdvexpo.eu).

## Brand notes

### Logos and icons

- Header logo: https://beam.be/wp-content/uploads/2026/04/Header-logo-svg-transparent.svg
- Footer logo: https://beam.be/wp-content/uploads/2026/04/Footer-Logo-SVG-Transparent.svg
- Brand icon/mark: https://beam.be/wp-content/uploads/2026/04/BEAM-icon-svg-transparent.svg
- Favicon: https://beam.be/wp-content/uploads/2026/04/icon-on-logo-512x512-1-300x300.webp (also available as -150x150)
- EES partner logo: https://beam.be/wp-content/uploads/2026/04/EES-logo-300x200-svg.svg
- Recurring decorative assets:
  - gold wave: https://beam.be/wp-content/uploads/2026/04/gold-wave.webp
  - wave under every hero: https://beam.be/wp-content/uploads/2026/04/Wave-under-hero-section-1920x300-webp-transparent.webp
  - section background: https://beam.be/wp-content/uploads/2026/04/Background-img-for-the-sections-1200x500-webp-transparent.webp
  - scalar wave: https://beam.be/wp-content/uploads/2026/04/scalar-wave.svg
  - wave backgrounds: https://beam.be/wp-content/uploads/2026/10/Blue-with-waves.webp and https://beam.be/wp-content/uploads/2026/10/White-with-waves.webp

### Colours

These come from the Elementor kit (`post-14.css`) and the v4 global variables.

| Token | Hex | Use |
|---|---|---|
| primary / `--dark_blue` | **#212842** | dark navy: headings (h2/h3), dark sections, text on light |
| secondary / `--gold` | **#D1A64A** | gold: links, accents, highlighted words in headings |
| text / `--black` | #000000 | body text |
| accent / `--white` | #FFFFFF | text on navy, backgrounds |
| custom "2fa7f2a" | **#FFFAEF** | warm cream: page-transition background, light sections |
| (CSS) | #FFD76A | light gold text colour (used about 49 times) |
| (CSS) | #F7E7B5, #A0621E | light and dark gold used in background gradients |

The **gold gradient** is used about 350 times as a button/element background:

`linear-gradient(90deg, rgba(166,92,20,1) 0%, rgba(247,204,120,1) 25%, rgba(224,184,106,1) 45%, rgba(252,239,191,1) 65%, rgba(248,213,137,1) 75%, rgba(181,118,39,1) 100%)`

That is #A65C14 → #F7CC78 → #E0B86A → #FCEFBF → #F8D589 → #B57627.

The WebinarGeek embeds use the same pair: accent #212842 and secondary #d1a64a.

### Fonts

All fonts are loaded from Google Fonts.

| Role | Font | Kit setting |
|---|---|---|
| Primary (titles) | **Poppins** | 600, 2.4rem (1.8rem on tablet/mobile), line-height 1.75 |
| Secondary (subtitles) | Poppins | 600, 1.7rem (1.4rem mobile) |
| Body text | Poppins | 400, 1.1rem, line-height 1.75 |
| h2 / h3 | Poppins | 500, 2.8rem / 2.4rem (2rem / 1.8rem on tablet), colour #212842, line-height 1.5 |
| Accent (serif) | **Rufina** | 500-600, 2.4-3rem, often gold; used for eyebrow labels and decorative titles |
| Extra | **Lora** | 600, 1.1rem (used rarely) |

The Trustindex review widget loads its own "Trustindex Poppins".

### Layout tokens

- Container max-width: 1140px (1024px on tablet). Widget spacing: 20px.
- v4 variables: `--section_pad: 3.5%`, `--row_column_space: 1.6rem`, `--title_text: 2.4rem`, `--sub_title_text: 1.7rem`.

Recurring section pattern: an eyebrow label, then an h2 with bold gold keywords, then a thin divider (`<hr>`), then body text, then a CTA.

## External tools and links found

| Tool | URL(s) | Used for | Pages |
|---|---|---|---|
| **SimplyBook.me** (custom domain book.beam.be) | https://book.beam.be/v2/#book (general); `#book/service/{2,14,18,19,22,23,58,69}`; `#book-class/service/50`; `#book/provider/31`; `#packages`, `#packages/{5,6,8,9,10,13,14,24}`; `#products` (membership) | Booking sessions, packages, membership, lectures | header/footer CTA, sessies, membership, faq, ervaringen, home, ervaar-beam, eerste-beam-ervaring, lezing-met-live-the-connection |
| **WebinarGeek** | embed script https://malong.webinargeek.com/malong.embed.js; registration identifiers `39d65633-04d0-4e99-a8bf-503cd59972b5` (webinar-je-systeem-is-uit-balans), `cd7b0771-2b13-4382-ae52-51c77c6821f6` (…-2), `e1afbbcf-5754-4170-9615-524a1cbb9ffc` (webinar-je-bent-niet-moe) | Free webinar registration (inline embed) | webinar pages |
| **Typeform** | https://embed.typeform.com/next/embed.js, live embed id `01M48XZ2RTQ7Y11XTH9730B579` | "Kies hier hoe je liefst informatie ontvangt" questionnaire | informatie-ontvangen |
| **Calendly** | https://calendly.com/brandepicbv/beam-intro-call | "Vraag een gesprek aan" corporate intro call | corporate, corporate-reset-day, corporate-venue, discovery-experience |
| **Ik Ben Aanwezig ticket shop** (iframe) | https://shop.ikbenaanwezig.nl/tickets/event/beam-kerstfeest-met-amber-haddad-ban?clean_iframe=on ; …/beam-internationale-concertreeks-ale?clean_iframe=on ; …/beam-internationale-concertreeks-pra?clean_iframe=on ; …/wat-als-2027-auberge-du-pecheur?clean_iframe=on | Concert and lecture tickets | concert pages, lezing-9-december |
| **Trustindex** (Google reviews widget) | https://beam.be/wp-content/uploads/trustindex-google-widget.css, cdn.trustindex.io | Google review slider ("UITSTEKEND, 145 recensies") | home, en-home, beam-reviews, ervaar-beam |
| **Google Maps** embed | maps embed for "BEAM Vitality Center" (place id 0x47c37751e55e22c9:0xaa3c680f517fc29) | Map | beam-reviews |
| **YouTube** | channel https://www.youtube.com/@beamvitalitycenter ; videos: shorts N58VfO6zlRQ (home "Ontdek BEAM in minder dan 1 minuut"), -8tzHbwZSZ8, B9Lb4WapDfU, RG-IDifKScE, zAkZJth5sM4, youtu.be/R1o8QF7xNOk, youtu.be/Rw3lAkiv3Hc and others on concert/corporate pages | Testimonial and promo videos | see the `[Video: …]` lines per page |
| **Elementor Forms** | posts to WordPress (admin-ajax) | Contact form, newsletter form (footer + contact page) | contact, footer |
| **WhatsApp** | https://wa.me/+32469413111 | Chat | contact, footer |
| Google Analytics 4 | gtag `G-ZWQY7Y2WF0` | Analytics | all pages |
| Meta Pixel | `2080698792877920` | Ads tracking | all pages |
| WPML | – | NL/EN translation | all pages |
| Rank Math | – | SEO, sitemap | all pages |

Not found anywhere on the site: **ScoreApp, Lightspeed and Mailchimp** (the newsletter is a native Elementor form, and its ESP is not visible). No cookie or consent banner was detected.

## What could not be captured

- **Content rendered by third-party widgets**: the WebinarGeek registration forms, the Typeform questionnaire, the ticket-shop iframes, the SimplyBook pages behind book.beam.be (service names and prices there) and the Google Maps map. Only their URLs and IDs are recorded.
- **Google reviews**: only the reviews that Trustindex pre-renders in the HTML (about 9 per page) are captured, not all 145. Video and text testimonials on `ervaringen`, `ervaar-beam`, `eerste-beam-ervaring` and the concert pages are captured in full.
- **Images**: listed only, not downloaded. Many images have empty alt text. Icons are inline SVG or Elementor icon fonts, so they are not listed.
- **Partner logos** on `partners` are inline SVGs, recorded only as "logo/graphic (inline SVG)" links.
