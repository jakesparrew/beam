# Site go-live: WordPress migration and DNS switch

Owner: site module (site spec sections 6 and 12, rules 52-53, 60-67). The platform-wide checklist is
`docs/runbooks/go-live.md`; this runbook covers the public website: moving the content off WordPress,
checking redirects and legal pages, switching DNS from the WordPress hosting to Vercel, monitoring,
and rolling back.

Who: the BEAM content owner (content review, publishing), the technical admin (Vercel, DNS, Better
Stack, Google Search Console). Every step in the back-office needs `site.publish`.

## Timeline

| When | Step |
| --- | --- |
| Week 7, Monday | Rehearsal on `staging` (section 1) |
| Week 8 minus 48 h | Lower the DNS TTL to 300 s (section 3.1) |
| Week 8, day before | Content freeze on WordPress, final export and import on production (section 2) |
| Week 8, switch day | Checks (section 3.2), DNS switch (section 3.3), monitoring (section 4) |
| Week 8 plus 30 days | Retire the WordPress hosting (section 5) |

## 1. Rehearsal on `staging` (week 7)

1. On WordPress: **Tools, Export**. Export pages, posts and media **separately** (one file per content
   type). The import refuses a file over 10 MB (rule 65); split further by date range if a file is
   still too large.
2. On `staging`, open **Website, WordPress import** (`/admin/site/imports`). Upload each file with
   the old site address `https://www.beam.be` and the default language `Nederlands`. Upload the
   **media file first**: pages then find their images in the media library.
3. Wait for the status **Ready to map** (the screen refreshes itself). If the status is **Failed**
   with "The file could not be read (line n)", fix the export (usually a plugin that writes invalid
   XML) and upload again.
4. Map the items:
   - Drafts and private items are set to **Skip**; keep it that way unless BEAM wants them.
   - Pages that WPML or Polylang did not group get a **Translation group**: give the Dutch and the
     French page the same value, so they become one page with two languages.
   - Items without a language get the default language; set **Language** where that is wrong.
   - Old pages that should not come back (old promotions, test pages) get **Redirect only** with the
     new page they should lead to.
5. **Apply import**. Media are fetched first (only from `https://www.beam.be` and the CDN host the
   file lists for `/wp-content/uploads/`), then every page and post becomes a **draft** with
   redirects from its old addresses, `/?page_id=` and `/?p=` links, attachment URLs, and `/feed`
   to `/nl/feed.xml`.
6. When the status is **Done**, read the report (removed shortcodes, dropped iframes, images that
   were not found). Items with **Error** (for example "media missing" after a network error) are
   fetched and converted again with **Retry failed items**; imported items are never duplicated.
7. Review every imported draft in the page editor: replace removed shortcodes (forms, galleries,
   price tables) with blocks, pick a poster image for each YouTube video, complete alt texts, SEO
   titles (1-70 characters) and descriptions (50-170 characters), and excerpts for posts.
8. **Publish complete imported pages** publishes every draft whose checks pass and lists the others
   with their issues. Repeat after fixing them.
9. Note the time each step took and every manual fix: the production run repeats them.

## 2. Content freeze and final import (week 8, day before)

1. Announce the content freeze: nobody edits WordPress from now on.
2. Export pages, posts and media again (step 1.1) and import them on **production** exactly as in
   the rehearsal. Items already imported by an earlier import (same old link) are skipped with
   "already imported", so a second file never creates duplicates.
3. Review and bulk publish (steps 1.7 and 1.8).

## 3. Switch

### 3.1 48 hours before: lower the TTL

At the DNS provider, set the TTL of the `www` CNAME and the apex A record of `beam.be` to **300
seconds**. Record the current values (hosting IP and CNAME target) in the change ticket: they are
the rollback values.

### 3.2 Checks before the switch (all must be green)

- **Redirect coverage at 100 %** of the old paths with traffic: on each import's page,
  "Old addresses without a page or redirect" lists every old path that resolves to neither a live
  page nor a redirect. Compare it with the top pages of the last 12 months in Google Analytics or
  Search Console; add redirects under **Website, Redirects** for every path with traffic.
- **Legal pages** published in nl, fr and en: privacy notice (names Vibrant Lifestyle Collective
  BV), terms with every chapter of rule 62 (general conditions, house rules, health
  self-declaration, cancellation policy, no right of withdrawal for date-specific bookings next to
  the 14-day withdrawal for undated purchases, membership conditions), cookie notice,
  **accessibility statement** (WCAG 2.1 AA, known exceptions, date of the last check, contact
  email) and **guardian consent**. `/admin/site` shows no red go-live banner.
- **Company details** in `/admin/settings`: legal name, registered address, enterprise number, support
  email and phone; the footer shows them on every page.
- Opening hours set (`opening_hours_missing` absent on `/admin/site`), the three menus complete.
- Spot checks on production: `https://<vercel-url>/nl`, `/fr`, `/en`, an old WordPress path (for
  example `/over-ons/`), an old `?page_id=` link, an old image URL, `/feed`, `/wp-admin` (410 Gone).

### 3.3 Vercel domains and the DNS switch (week 8)

1. In Vercel, **Project, Settings, Domains**: add `www.beam.be` as the **primary** domain and
   `beam.be` with **redirect to `https://www.beam.be`** (308). Vercel shows the DNS records it needs.
2. At the DNS provider: point the `www` CNAME to `cname.vercel-dns.com` and the apex A record of
   `beam.be` to `76.76.21.21` (use the values Vercel shows if they differ).
3. Wait until Vercel shows both domains as valid and the certificate is issued (usually minutes with
   TTL 300).
4. Check from a phone on mobile data and from a desktop: `https://beam.be` redirects to
   `https://www.beam.be`, which shows the new site; the spot checks of 3.2 pass on `www.beam.be`.
5. In **Google Search Console**: verify the domain property if needed, submit
   `https://www.beam.be/sitemap.xml`, and request indexing of the home page in each language.
6. Raise the TTL back to 3600 s after 48 hours without rollback.

## 4. Monitoring

- **Better Stack** HTTP monitor (site spec section 6): `GET https://www.beam.be/nl` every 60 s,
  expects status 200 and the keyword from `settings.company.trade_name`, alert after 2 failures to
  `#beam-alerts`, severity Critical (the public site is the booking entry). It counts towards the
  99.5 % monthly uptime target of the monthly report.
- During the first week, check daily: **Website, Redirects** (redirects with hits show which old
  links are used), Search Console coverage errors (404s from old URLs: add a redirect for each), and
  the 404 log in Sentry.

## 5. Rollback

Rollback is possible for **30 days**: the WordPress hosting stays online, unchanged, until then.

1. Decide (content owner and technical admin) and note the reason in the incident log
   (`docs/runbooks/incident.md`).
2. At the DNS provider, restore the recorded values of 3.1 (the WordPress hosting IP and CNAME). With
   TTL 300 the old site is back within minutes.
3. Remove `www.beam.be` and `beam.be` from the Vercel project only if they block the rollback.
4. Bookings, orders and accounts stay in the platform (the portal keeps working on its Vercel URL);
   only the public pages go back to WordPress.
5. After 30 days without rollback: cancel the WordPress hosting, keep the final WXR exports in the
   archive, and delete the imports' files only after the redirects are confirmed complete.
