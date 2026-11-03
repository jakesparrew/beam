# Module spec: site (Public website, portal home)

Module id `site`. Owner paths: `packages/db/src/schema/site.ts`, `packages/db/src/schema/site.views.ts`, `packages/core/src/site/`, `apps/web/modules/site/`, `apps/web/app/[locale]/(site)/*` except the folders other modules own (`f/` forms; `claim/` booking; `checkout/`, `pay/`, `gift/` commerce; `preferences/` email; `webinars/` (incl. `webinars/[slug]` and `webinars/[slug]/join`) and `w/[token]` webinar), `apps/web/app/(admin)/admin/site/*`, the portal layout `apps/web/app/[locale]/(portal)/account/layout.tsx` (taken over from Wave 1; platform-P6 writes only its first version) and the portal home page `apps/web/app/[locale]/(portal)/account/page.tsx` (platform keeps `loading.tsx`, `error.tsx`, `security/`, the `(portal-auth)` sign-in pages and the `PortalShell` component; crm owns `account/profile`), `apps/web/app/{sitemap.ts,robots.ts,manifest.ts,sw.ts}`, `apps/web/app/pwa-icon/`, `apps/web/app/api/public/cookie-consent/`, `packages/integrations/src/wordpress/`, `packages/core/src/i18n/messages/*/site.json`, `packages/db/src/seed/site.ts`, `docs/runbooks/site-go-live.md`.

Blueprint sections: 10 (portal), 50 (third-party integrations, Google Analytics, WordPress), 81 (app: responsive web first, PWA), 82 (no extra complexity for a future multi-client offer). Also used: 3 (origin), 9 (opening hours, closures), 15 (events), 16 (website forms, landing pages, UTM), 17 (result and booking CTAs), 19 (accurate availability, no public ranking), 33 (attribution, R3), 44 (referral links, R3), 45-46 (pricing), 53 (migration), 56 (audit), 57-63 (GDPR, cookies, retention), 64 (security), 72 (monitoring), 76-77 (acceptance, go-live).

## 1. Purpose and release mapping

The site module replaces BEAM's WordPress website with a native, multilingual website at `/nl`, `/fr` and `/en`, edited by BEAM staff in the back-office and with Claude's help. It turns the catalogue (products, prices) and the booking calendar (event sessions) into public pages, embeds the forms module's lead forms, and sends visitors into the customer portal to book and buy. It also owns the portal layout (`/[locale]/account/layout.tsx`: customer session check, platform's `PortalShell` and site's `PortalSiteChrome`), the portal home page (`/[locale]/account`), `PortalSiteChrome` (terms banner, consent-gated analytics, cookie-settings link), and the PWA manifest and service worker shared by site and portal. Platform owns the `PortalShell` component (navigation from every module's `nav.ts` entries with `audience: 'customer'`), the portal `loading.tsx`, `error.tsx` and sign-in pages; crm owns the profile page; every other portal page belongs to its module.

| Release | Weeks | What this module ships |
| --- | --- | --- |
| V1 | 1-6 (live with the go-live in week 8, DNS switch from WordPress) | Pages and immutable page versions with blocks per locale; page kinds home, standard, offer, pricing, events index, event, blog index, post, contact, legal, landing; navigation menus; media library with alt text per locale; pricing tables from the catalogue; events listing and detail pages from booking sessions of kind `event`; availability previews and booking entry points into the portal, the site guest checkout and the gift-voucher page (both commerce); opening hours and upcoming closures from booking; contact page and footer newsletter through forms' `FormBlock`; blog/news with RSS; legal pages (privacy notice naming Vibrant Lifestyle Collective BV, versioned terms that include the house rules, the health self-declaration, the cancellation policy, the no-withdrawal notice for date-specific bookings and the membership conditions, with acceptance records, cookie notice, accessibility statement, guardian consent form for crm's minor declarations); company identification in the footer (Belgian Code of Economic Law, book XII); SEO (metadata, hreflang, canonical, sitemap.xml, robots.txt, JSON-LD); cookie banner and consent-gated Vercel Analytics and Google Analytics 4; WCAG 2.1 AA and performance budgets; Claude-assisted editing with proposals, side-by-side diff review and publish; scheduled publishing; redirects; WordPress import (WXR export, mapping, media, redirects from old URLs) and the go-live runbook with the DNS switch and uptime monitor; PWA manifest, icons, service worker, offline page and install prompt; portal layout and portal home (upcoming bookings, balances, membership summary, open waitlist offers, quick actions including "Invite a guest") and `PortalSiteChrome` (new-terms banner on every portal page, consent-gated analytics); integration classification of blueprint 50 (section 6) |
| Release 2 | 9-10 | Events and ticketing extensions on public pages: ticket types with public and member prices, lead-magnet messaging ("Priority access for new guests until ...") with a "Check your access" button instead of a booking button that would fail (scenario 3), sold-out to waitlist entry; `webinar_signup` block (renders the webinar module's `WebinarSignup` server component, a card linking to its own registration page) and "Register for the webinar" on event pages linked to a webinar; account home cards for upcoming webinars (flag `ff_webinar_portal`) and "Shared with me" packages (guest and package-sharing controls, credits R2) |
| Release 3 | 11-12 | Marketing consent category activates Google Ads conversion tag and Meta Pixel; partner landing pages (`pages.partner_company_id`) that stamp the partner on leads; referral links `?ref=<CODE>` kept in cookie `beam_ref` (30 days, marketing consent) for credits' referral programme; landing-page insights screen (leads and orders per landing page and UTM campaign) for campaign attribution |
| Release 4 | 13-14 | Claude translation proposals that fill missing locales of a page; weekly Claude content and SEO audit report on the site dashboard |
| Later (out of scope) | after the build-out | Native mobile app (blueprint 81; the PWA covers V1) and web push notifications (email stays the notification channel), site search, A/B testing, personalised public content by customer status, gamification, multi-client theming for a BRANDEPIC offer (blueprint 82: content and branding are config, nothing more), headless CMS export |

Coverage of blueprint 10 (portal) and 81 (app). The site owns the portal home and the chrome; every other bullet is a page of its owning module, reached from the portal navigation and the home quick actions.

| Blueprint bullet | Where it lives | Release |
| --- | --- | --- |
| View upcoming bookings | site home card (next 5); booking `/[locale]/account/bookings` | V1 |
| Make bookings | booking `/[locale]/account/book`, `/book/[sessionId]` (entry points from site pages and home) | V1 |
| Cancel / reschedule | booking `/[locale]/account/bookings/[id]`, `/reschedule` | V1 |
| View previous visits | booking `/[locale]/account/bookings` (past tab) | V1 |
| View package balance, credits, expiry date | site home balance card; credits `/[locale]/account/packages` | V1 |
| Purchase packages, purchase sessions | commerce `/[locale]/account/shop` and `/account/checkout`; session purchase from booking's book page | V1 |
| View membership, renew membership | site home membership card; credits `/[locale]/account/membership` (`payMyRenewal` when past due) | V1 |
| Update personal details | crm `/[locale]/account/profile` | V1 |
| Manage communication preferences | email `/[locale]/account/preferences` | V1 |
| View event registrations | booking `/[locale]/account/bookings` (events tab); webinar `/[locale]/account/webinars` | V1, webinars R2 |
| Access invoices | finance `/[locale]/account/invoices` | V1 |
| Invite a guest | booking `/[locale]/account/bookings/[id]` (invite a guest), home quick action | V1 (sharing limits R2) |
| Share eligible package usage | credits `/[locale]/account/packages/[grantId]` sharing section, home "Shared with me" card | R2 |
| View waitlist / offered-seat status | site home offers card; booking `/[locale]/account/waitlist` | V1 |
| Responsive web first; app later (81: login, booking, package balance, membership, events, payments, content) | installable PWA over the same pages (section 5) | V1 |
| App notifications (81) | email and the portal; web push and a native app are Later | Later |

## 2. Domain model

All tables live in `packages/db/src/schema/site.ts`; views in `site.views.ts`. Conventions from architecture section 2 apply (`id uuid pk default gen_random_uuid()`, `created_at timestamptz not null default now()`, `updated_at` on mutable tables, enums `pgEnum('<table>_<column>')`). `Locale` is the shared enum `nl-BE | fr-BE | en` from `_shared.ts`. Wave 0 created the contract table `pages` with minimal columns; P1 completes it without changing existing columns.

### Enums

| Enum | Values |
| --- | --- |
| `pages_kind` | `home, standard, offer, pricing, events_index, event, blog_index, post, contact, legal, landing` |
| `pages_status` | `draft, published, archived` |
| `pages_legal_key` | `privacy_notice, terms, cookie_notice, accessibility_statement, guardian_consent` (the house rules, the health self-declaration and the membership conditions are chapters of `terms`, decisions 41 and 53; `guardian_consent` is the parental consent document crm's `person_declarations` reference, decision 54) |
| `page_versions_state` | `draft, proposed, published, rejected, superseded` (`superseded` = a proposal copied into the draft) |
| `page_versions_created_by` | `user, claude` |
| `redirects_source` | `wordpress, rename, archive, manual` |
| `nav_menus_key` | `header, footer, legal` |
| `media_assets_source` | `upload, wordpress` |
| `page_edit_requests_kind` | `edit, new_page, translate` (`translate` used from R4) |
| `page_edit_requests_status` | `pending, running, succeeded, failed, cancelled` |
| `terms_acceptances_context` | `checkout, signup, booking, portal_prompt, pos, import` |
| `cookie_consents_action` | `accept_all, reject_all, custom, withdraw` |
| `wordpress_imports_status` | `uploaded, parsing, parsed, applying, done, failed` |
| `wordpress_import_items_wp_type` | `page, post, attachment` |
| `wordpress_import_items_decision` | `import, skip, redirect_only` |
| `wordpress_import_items_status` | `pending, imported, skipped, error` |

### `pages` (mutable; one row per logical page)

| Column | Type | Null | Default / check |
| --- | --- | --- | --- |
| id | uuid | no | `gen_random_uuid()` |
| kind | `pages_kind` | no | |
| slug | text | no | unique; internal key, check `slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'` and `length(slug) <= 80` |
| status | `pages_status` | no | `'draft'` |
| current_version_id | uuid | yes | FK `page_versions.id` (the live version; set only by publish) |
| legal_key | `pages_legal_key` | yes | check `(kind = 'legal') = (legal_key is not null)` |
| session_id | uuid | yes | FK `sessions.id` on delete set null; check `session_id is null or kind = 'event'` |
| partner_company_id | uuid | yes | R3 column, FK `companies.id` on delete set null; check `partner_company_id is null or kind = 'landing'` |
| first_published_at | timestamptz | yes | set once on first publish (post ordering) |
| archived_at | timestamptz | yes | |
| archived_by_user_id | uuid | yes | FK `users.id` |
| created_by_user_id | uuid | yes | FK `users.id` (null for seed and import) |
| created_at, updated_at | timestamptz | no | `now()` |

Indexes and constraints: unique `slug`; partial unique `pages_singleton_kind_uq (kind) where kind in ('home','events_index','blog_index','contact') and status <> 'archived'`; partial unique `pages_legal_key_uq (legal_key) where legal_key is not null and status <> 'archived'`; partial unique `pages_session_uq (session_id) where session_id is not null and status <> 'archived'`; index `(kind, status)`; index `(first_published_at desc) where kind = 'post' and status = 'published'`. Invariant: `status = 'published'` implies `current_version_id is not null` (check constraint `status <> 'published' or current_version_id is not null`).

### `page_versions` IMMUTABLE once `published_at` is set

| Column | Type | Null | Default / check |
| --- | --- | --- | --- |
| id | uuid | no | |
| page_id | uuid | no | FK `pages.id` on delete restrict |
| version | integer | no | `> 0`; allocated as `max(version) + 1` under `select ... from pages where id = $1 for update` |
| state | `page_versions_state` | no | `'draft'` |
| title | jsonb `LocalizedText` | no | `'{}'` |
| paths | jsonb `Partial<Record<Locale,string>>` | no | `'{}'`; path without locale prefix and without leading slash, `''` for home |
| blocks | jsonb `Partial<Record<Locale, Block[]>>` | no | `'{}'`; validated by `BlocksByLocale` (core) on every write |
| seo | jsonb `Partial<Record<Locale,{title:string;description:string;ogImageMediaId?:string;noindex?:boolean}>>` | no | `'{}'` |
| excerpt | jsonb `LocalizedText` | yes | posts, events and landing cards |
| cover_media_id | uuid | yes | FK `media_assets.id` on delete restrict |
| locales | text[] | no | `'{nl-BE,fr-BE,en}'`; check `locales <@ array['nl-BE','fr-BE','en'] and cardinality(locales) >= 1` |
| is_material_change | boolean | no | `false`; meaningful for legal pages (terms re-acceptance, cookie banner re-prompt) |
| change_summary | text | yes | `<= 500` chars; written by staff or Claude |
| based_on_version_id | uuid | yes | FK `page_versions.id`; the version this one was derived from (diff base) |
| created_by | `page_versions_created_by` | no | `'user'` |
| created_by_user_id | uuid | yes | FK `users.id`; for Claude rows the staff member who asked |
| edit_request_id | uuid | yes | FK `page_edit_requests.id` on delete set null |
| proposed_by_ai_request_id | uuid | yes | plain uuid, no FK (`ai_requests` is purged after 30 days) |
| scheduled_publish_at | timestamptz | yes | |
| published_at | timestamptz | yes | |
| published_by_user_id | uuid | yes | FK `users.id`; null when the scheduled job published (audit row names the scheduler) |
| rejected_at | timestamptz | yes | |
| rejected_by_user_id | uuid | yes | FK `users.id` |
| reject_reason | text | yes | `<= 500` |
| created_at, updated_at | timestamptz | no | |

Constraints: unique `(page_id, version)`; partial unique `page_versions_one_draft_uq (page_id) where state = 'draft'`; check `(state = 'published') = (published_at is not null)`; check `state <> 'rejected' or rejected_at is not null`; check `created_by = 'user' or state <> 'draft'` (a Claude row is never a draft); check `state <> 'superseded' or created_by = 'claude'`; check `scheduled_publish_at is null or state in ('draft','proposed')`. Indexes: `(page_id, state)`, `(scheduled_publish_at) where scheduled_publish_at is not null`, `(edit_request_id)`. Invariant (enforced in `server/versions.ts` and tested): an UPDATE on a row with `published_at is not null` is refused; only `draft` rows accept content updates; `proposed` rows accept only `state -> rejected|published`.

### `page_routes` (mutable projection of live paths)

| Column | Type | Null | Notes |
| --- | --- | --- | --- |
| id | uuid | no | |
| page_id | uuid | no | FK `pages.id` on delete cascade |
| locale | `locale` | no | |
| path | text | no | check `path = '' or path ~ '^[a-z0-9]+(-[a-z0-9]+)*(/[a-z0-9]+(-[a-z0-9]+)*){0,2}$'`, `length(path) <= 200` |
| version_id | uuid | no | FK `page_versions.id` (the published version that set it) |
| created_at, updated_at | timestamptz | no | |

Unique `(locale, path)`; unique `(page_id, locale)`. Rows exist only for `published` pages and only for locales in the live version's `locales`. Rewritten in the publish transaction; deleted on unpublish and archive.

### `redirects` (mutable)

| Column | Type | Null | Notes |
| --- | --- | --- | --- |
| id | uuid | no | |
| from_path | text | no | unique; normalised by `normalisePath()`: leading `/`, lower-case, no trailing slash except `/`, query dropped except `p` and `page_id` (WordPress ids); check `from_path !~ '^/(admin|api|_next)(/|$)'` |
| to_page_id | uuid | yes | FK `pages.id` on delete cascade |
| to_locale | `locale` | yes | |
| to_url | text | yes | site-relative path starting with `/` or `https://` URL, `<= 500` |
| is_permanent | boolean | no | `true` (308 via `permanentRedirect`), false = 307 |
| source | `redirects_source` | no | |
| hits | integer | no | `0` |
| last_hit_at | timestamptz | yes | |
| created_by_user_id | uuid | yes | FK `users.id` |
| created_at, updated_at | timestamptz | no | |

Check `(to_page_id is not null and to_locale is not null and to_url is null) or (to_page_id is null and to_locale is null and to_url is not null)`; check `to_url is null or to_url <> from_path`. Index `(to_page_id)`. A redirect to a page resolves to that page's current route at request time, so renames never create chains. `hits` and `last_hit_at` are written with `after()` only when the resolver actually runs (at most once per path per cache window), so the admin shows them as "seen at least n times, last seen" and never as an exact count.

### `nav_menus` (mutable, history in `audit_log`)

Columns: id; key `nav_menus_key` not null unique; items jsonb not null default `'[]'` (`NavItem[]`, max 8 top-level items, max depth 2, max 12 children); version integer not null default 1 (optimistic lock, incremented on every save); updated_by_user_id uuid null FK users; created_at; updated_at. `NavItem = { id: string; label: LocalizedText; target: Link; children?: NavItem[] }`.

### `media_assets` (mutable)

Columns: id; file_id uuid not null unique FK `files.id` on delete restrict (file kind `image`, `is_public = true`); alt jsonb `LocalizedText` not null default `'{}'`; is_decorative boolean not null default false; width integer not null check `> 0`; height integer not null check `> 0`; caption jsonb `LocalizedText` null; credit text null `<= 200`; source `media_assets_source` not null default `'upload'`; wordpress_url text null; uploaded_by_user_id uuid null FK users; created_at; updated_at. Index `(source)`, unique partial `(wordpress_url) where wordpress_url is not null`. Allowed mimes: `image/jpeg, image/png, image/webp, image/gif`, exactly platform's `files_mime_ck` (no SVG, no AVIF; `next/image` serves AVIF and WebP renditions to browsers anyway). Max 10 MB (the `files` limit).

### `page_edit_requests` (mutable)

Columns: id; page_id uuid not null FK pages; kind `page_edit_requests_kind` not null default `'edit'`; instruction text not null check `length between 3 and 4000`; locales text[] not null (target locales, default the base version's locales); base_version_id uuid null FK page_versions (null for `new_page` on an empty page); base_updated_at timestamptz null (snapshot of the base row's `updated_at`); status `page_edit_requests_status` not null default `'pending'`; requested_by_user_id uuid not null FK users; result_version_id uuid null FK page_versions; ai_request_id uuid null (no FK); error_code text null check in (`budget_exceeded`, `invalid_output`, `ai_unavailable`, `page_archived`); error_message text null; finished_at timestamptz null; created_at; updated_at. Partial unique `page_edit_requests_active_uq (page_id) where status in ('pending','running')`; index `(page_id, created_at desc)`.

### `terms_acceptances` APPEND

Columns: id; person_id uuid not null FK `persons.id`; page_version_id uuid not null FK `page_versions.id`; legal_key `pages_legal_key` not null (V1 writes `terms`; `privacy_notice` acknowledgements reuse it); context `terms_acceptances_context` not null; ref_type text null (`order`, `booking`, `user`); ref_id uuid null; ip text null (personal data, not sensitive); idempotency_key text not null unique (`terms:<person_id>:<page_version_id>:<context>:<ref_id|none>`); accepted_at timestamptz not null default now(); created_at. Index `(person_id, legal_key, accepted_at desc)`. Append-only trigger from `0002_append_only.sql` (table added to `APPEND_ONLY_TABLES`). crm's merge never rewrites append-only rows, so every read by person (`hasAcceptedCurrentTerms`, the terms banner, export, erase) runs over `crm.resolvePersonIds(personId)` (the person plus every person merged into it).

### `cookie_consents` APPEND

Columns: id; consent_key uuid not null (random id stored in the visitor's `beam_consent` cookie); person_id uuid null FK `persons.id` (set when a customer session exists); choices jsonb not null `{ analytics: boolean; marketing: boolean }`; banner_version integer not null (the published ordinal of the cookie notice); action `cookie_consents_action` not null; locale `locale` not null; ip_hash text null (HMAC-SHA256 of the IP with `AUTH_SECRET`, first 32 hex chars; personal data); recorded_at timestamptz not null default now(); created_at. Indexes `(consent_key, recorded_at desc)`, `(person_id) where person_id is not null`, `(recorded_at)`.

### `wordpress_imports` (mutable)

Columns: id; file_id uuid not null FK files (kind `import`, the WXR XML); site_origin text not null (old site, e.g. `https://www.beam.be`, check `~ '^https://'`); default_locale `locale` not null default `'nl-BE'`; status `wordpress_imports_status` not null default `'uploaded'`; counts jsonb not null default `'{}'` (`{pages, posts, attachments, imported, skipped, errors, redirects}`); report jsonb not null default `'{}'` (shortcodes stripped, unsupported tags, unresolved links); created_by_user_id uuid not null FK users; applied_at timestamptz null; created_at; updated_at.

### `wordpress_import_items` (mutable)

Columns: id; import_id uuid not null FK `wordpress_imports.id` on delete cascade; wp_id integer not null; wp_type enum not null; wp_status text not null (`publish`, `draft`, `private`, `inherit`); locale `locale` null; translation_group text null (WPML `trid` or Polylang group); parent_wp_id integer null; title text not null; wp_link text not null; wp_path text not null (normalised); content_html text null; excerpt text null; published_at timestamptz null; attachment_url text null; decision enum not null default `'import'` (`'skip'` for non-`publish` items); target_page_id uuid null FK pages; target_media_id uuid null FK media_assets; redirect_to_page_id uuid null FK pages; status enum not null default `'pending'`; message text null; created_at; updated_at. Unique `(import_id, wp_type, wp_id)`; index `(import_id, status)`. Authors, comments and user emails from the WXR file are never stored.

### R4 addition: `site_audit_reports` APPEND

Columns: id; week_on date not null unique (Monday, Europe/Brussels); findings jsonb not null (`{pageId, locale, severity: 'info'|'warn', code, message}[]`); ai_request_id uuid null; created_at.

### Views (`site.views.ts`, Drizzle `pgView` with `.as(sql\`...\`)`)

```sql
-- live pages with their live version
create view v_published_pages as
select p.id as page_id, p.kind, p.slug, p.legal_key, p.session_id, p.partner_company_id, p.first_published_at,
       v.id as version_id, v.version, v.title, v.locales, v.seo, v.excerpt, v.cover_media_id, v.published_at, v.is_material_change
from pages p join page_versions v on v.id = p.current_version_id
where p.status = 'published';

-- event sessions with their optional event page (listing source)
create view v_site_events as
select s.id as session_id, s.title as session_title, s.starts_at, s.ends_at, s.status as session_status,
       s.is_member_only, s.is_lead_magnet, s.lead_window_end_at, s.location,
       p.id as page_id, v.id as version_id, v.locales, v.title as page_title, v.excerpt, v.cover_media_id
from sessions s
left join pages p on p.session_id = s.id and p.status = 'published'
left join page_versions v on v.id = p.current_version_id
where s.kind = 'event' and s.status <> 'cancelled';

-- published ordinal per legal version (displayed as "Version n"; also the cookie banner version)
create view v_legal_versions as
select p.legal_key, v.id as version_id, v.published_at, v.is_material_change,
       row_number() over (partition by p.legal_key order by v.published_at) as ordinal,
       (v.id = p.current_version_id) as is_current
from pages p join page_versions v on v.page_id = p.id
where p.legal_key is not null and v.published_at is not null;

-- latest acceptance per person and legal document
create view v_terms_acceptance_latest as
select distinct on (person_id, legal_key) person_id, legal_key, page_version_id, accepted_at, context
from terms_acceptances order by person_id, legal_key, accepted_at desc;

-- admin overview
create view v_site_page_overview as
select p.id as page_id, p.kind, p.slug, p.status, p.current_version_id,
       (select v.id from page_versions v where v.page_id = p.id and v.state = 'draft') as draft_version_id,
       (select count(*) from page_versions v where v.page_id = p.id and v.state = 'proposed')::int as open_proposals,
       (select max(v.published_at) from page_versions v where v.page_id = p.id) as last_published_at,
       p.updated_at
from pages p;
```

Prices are deliberately not part of any site view: an event's price comes from `sessions.product_id` (and from R2 its `ticket_types`) through `commerce.getProductPrice()`, so price rules stay in commerce. Availability comes from `booking.getAvailabilityPreview()`, `booking.listPublicEvents()` (`availabilityBand`) and `booking.getAvailability()`, never from counting rows here.

### Tables of other modules this module reads or writes

| Table | Module | Access |
| --- | --- | --- |
| `sessions` | booking | read (view `v_site_events`, FK `pages.session_id`); listing through `booking.listPublicEvents()`, availability only through `booking.getAvailabilityPreview()` (bands) and `booking.getAvailability()` (one session) |
| `session_exceptions` | booking | not read directly: closures and special hours come from `booking.getOpeningHours(db, { from, to })` (rule 58) |
| `products`, `price_versions` | commerce | read `products` (`sku, kind, name, credit_kind, credit_units, validity_days, member_discount_pct, is_active`); prices only through `commerce.getProductPrice()` |
| `files` | platform | write through `storeFile(ctx, …)` (media, WXR upload); read through `/api/public/files/[id]` |
| `settings` | platform | declares key `site` in `M/config.ts` (edited at platform's `/admin/settings/site`); reads `company`, `business_hours` (booking) |
| `ai_requests` | platform | written by `callClaude()` on every Claude call |
| `audit_log`, `jobs`, `activity_events` | platform, crm | written through `ctx.audit`, `ctx.enqueue`, `ctx.recordEvent` |
| `persons` | crm | FK from `terms_acceptances`, `cookie_consents`; identity reads through `crm.getPerson()` and `crm.resolvePersonIds()` |
| `users` | platform | FK for authorship |
| `companies` | crm | FK `pages.partner_company_id` (R3) |
| `retention_policies` | ops | seed inserts three site rows (`on conflict (key) do nothing`) |

## 3. Business rules

Pages, versions and publishing
1. Locale prefixes map one to one: `/nl` = `nl-BE`, `/fr` = `fr-BE`, `/en` = `en`. A bare path is redirected by `proxy.ts` (Wave 0); the site never renders without a prefix.
2. A page is visible to the public only when `pages.status = 'published'`; the public always sees `current_version_id`, never a draft or proposal.
3. A page has at most one `draft` version. Editing a page with no draft creates one copied from the current version (`based_on_version_id` = current).
4. A version with `published_at` set is never updated or deleted. A rollback is "restore version n": a new draft copied from version n, then a normal publish.
5. Publishing runs `checkPublishable(version, refs)` and refuses with the full issue list when any check fails, for every locale in `version.locales`: `title[locale]` non-empty and `<= 120` chars; `paths[locale]` valid (rule 9) and not taken by another page in that locale; `seo[locale].title` 1-70 chars and `seo[locale].description` 50-170 chars; `blocks[locale]` has 1-60 blocks and each passes its strict Zod schema; every referenced media asset has `alt[locale]` or `is_decorative`; posts, events and landing pages have `excerpt[locale]`.
6. Cross-module references are checked at publish: `form_embed.formSlug` is a published form whose `locales` include every locale of the version (`forms.getPublishedFormMeta(db, slug)` returns non-null `{ formId, locales }`), `pricing_table.productIds` and `booking_cta` `buy_product` targets are active products, `booking_cta.sessionId` and `pages.session_id` are existing sessions of kind `event`, `webinar_signup.webinarId` is a published webinar (`webinar.listPublicWebinars()`, R2), `link.pageId` targets are published or archived pages with a redirect. Any failure blocks publish.
7. Publishing is one transaction: lock the page row, set the version `published`, `published_at = ctx.now`, `published_by_user_id`; set `pages.current_version_id`, `status = 'published'`, `first_published_at` if null; rewrite `page_routes`; create rename redirects (rule 11); write `audit_log` `site.page.publish` with old and new version ids; then revalidate cache tags `site:page:<id>`, `site:routes`, `site:nav`, `site:sitemap`.
8. Only a staff user with `site.publish` publishes, schedules, unpublishes or archives. A version created by Claude can only be published by a human action; no job publishes a Claude version unless a human scheduled it.
9. Paths are lower-case `a-z0-9` words joined by hyphens, at most 3 segments, each at most 60 chars. The home page path is `''` and only the `home` page may use it. First segments `account, f, claim, checkout, pay, gift, preferences, webinars, w, api, admin, preview, unavailable, offline, feed.xml, sitemap.xml, robots.txt, manifest.webmanifest, pwa-icon, _next` are reserved (the folders of other modules and this module's own routes). A path `events/<uuid>` is reserved for the stable event link (rule 57).
10. Exactly one non-archived page each of kind `home`, `events_index`, `blog_index`, `contact`, and one per `legal_key`.
11. When publishing changes a page's path in a locale, a redirect `source = 'rename'` is inserted from `/<prefix>/<old path>` to the page and locale. A redirect whose `from_path` equals a new live path is deleted in the same transaction, so the page wins.
12. Unpublish sets `status = 'draft'` and deletes the page's routes; archive sets `status = 'archived'` and deletes routes. Both may create one redirect (`source = 'archive'`) to a chosen target. Without one, an archived page's old paths answer 410 Gone, an unpublished page's paths 404.
13. Scheduled publishing: `scheduled_publish_at` must be at least 5 minutes and at most 365 days ahead. The job re-runs every publish check at the scheduled time; when a check fails the version stays unpublished, the schedule is cleared and the page shows a red "scheduled publish failed" issue on `/admin/site`.
14. A saved draft that was already scheduled keeps its schedule; discarding a draft cancels it.
15. Saving a draft uses optimistic locking: the action carries the `updated_at` it loaded; a mismatch returns `conflict` and nothing is written.
16. When a version is published while another draft exists whose `based_on_version_id` differs from the new live version, the editor marks that draft "out of date" and offers "keep" or "discard"; it is never merged automatically.

Page and version states (every transition below has a test in site-P3 `pages.test.ts`; any other transition is refused with `conflict`)
54. `pages.status`: `draft -> published` (publish), `published -> published` (publish a newer version), `published -> draft` (unpublish), `draft|published -> archived` (archive), `archived -> draft` (`restoreArchivedPage`, `site.publish`; refused with `conflict` when the slug, the singleton kind, the `legal_key` or the `session_id` is now taken by another non-archived page; deletes the page's `source = 'archive'` redirects). No state is terminal and none is unreachable.
55. `page_versions.state`: `draft -> published` (publish), `draft -> deleted` (discard; the row is deleted, which is allowed because it never had `published_at`), `proposed -> published`, `proposed -> rejected` (`rejectProposal`, or archiving the page: reason `Page archived`), `proposed -> superseded` (`copyProposalToDraft`). `published`, `rejected` and `superseded` are final for the row; a published row stays `published` after a newer version goes live (only `pages.current_version_id` says which one is live).
56. `page_edit_requests.status`: `pending -> running` (job start), `pending -> cancelled` (`cancelProposalRequest`), `running -> succeeded` (proposal inserted), `pending|running -> failed` (`budget_exceeded`, `invalid_output`, `ai_unavailable` on the last attempt, `page_archived` when the page was archived before the job ran). A dead `site.propose_page` job always leaves the request `failed`, so the "one active request per page" lock never sticks.

Blocks and content
17. Blocks are stored per locale. Each block has a stable `id` (uuid) unique within its locale list. The allowed types are defined once in `packages/core/src/site/blocks.ts` (section 4).
18. Exactly one `h1` per page: the `hero.heading` if the first block is a `hero`, otherwise the version title. `hero` is allowed only as the first block. Rich text allows `h2`-`h4` only.
19. Rich text is a structured document (`RichDoc`, Tiptap-compatible JSON) with paragraphs, headings 2-4, bullet and numbered lists, blockquote, bold, italic and links. It is rendered by an in-house renderer; no HTML string is ever injected.
20. External links open in the same tab and get `rel="noopener"`; `href` must be `https:`, `mailto:`, `tel:` or a site path. `javascript:` and `data:` are rejected by the Zod schema.
21. A `testimonial` block requires `consentConfirmed: true` (the staff member confirms the person agreed to be quoted).
22. A `video` block embeds YouTube only through `youtube-nocookie.com` behind a click-to-load facade whose poster is a required media-library image (`posterMediaId`, never `i.ytimg.com`); nothing loads from Google until the visitor clicks.
23. A `map` block is a static image with a link to the map provider; no third-party map iframe is embedded.
24. Navigation items whose target page is unpublished, archived or not available in the current locale are hidden in that locale and listed as content issues.

Catalogue, events and booking entry points
25. Prices on the site come only from `commerce.getProductPrice(db, productId, 'public')` (and `'member'` for the member line) and are shown VAT included, formatted with `Intl.NumberFormat(locale, { style: 'currency', currency: 'EUR' })`. The site never stores a price amount.
26. A `pricing_table` shows the public price and, when the product has a `member` price version or `member_discount_pct > 0`, the line "Members: <amount>" (the member price version, or the public price minus the discount rounded half up to the cent, exactly as `quote()` would). Inactive products are omitted from the rendered table and flagged as issues.
27. Dynamic data blocks (prices, events, availability, opening hours) are cached for at most 300 seconds; a price, session or closure change is visible on the site within 5 minutes.
28. The events listing reads `booking.listPublicEvents(db, { from: now, limit: 12, offset: (page - 1) * 12 })` (anonymous, sessions of kind `event` including webinar-linked ones) and shows sessions with `starts_at >= now()` and status `open` or `closed`, ordered by `starts_at`, 12 per page, with the row's `availabilityBand`. Cancelled sessions are not listed. `closed` or full sessions show "Full" with a "Join the waitlist" entry point.
29. An event detail page for a past session stays reachable with a "This event has taken place" banner, is excluded from the sitemap and gets `noindex` 30 days after `ends_at`. A cancelled session's page shows "This event was cancelled" and `noindex`.
30. Seats left are shown only as bands: "Available", "Few places left" (`bookable` fewer than 5, or below 10 % of `capacity`) and "Full" (`bookable = 0` or `reason = 'full'`). The `availability_preview` block takes them from `booking.getAvailabilityPreview(db, { kind, from: start of today, to: start of today + days })` and the events listing from `listPublicEvents().availabilityBand`; only the event detail page computes `bandFor()` from `booking.getAvailability(db, { sessionId })` for an anonymous viewer, with the same thresholds (booking's band and site's `bandFor` share them; `availability.test.ts` pins them). No exact counts and no queue position are ever shown publicly (blueprint 19). The portal's own booking pages (booking module) may show exact small counts to signed-in customers.
31. Booking entry points: day and night booking `/<prefix>/account/book?kind=day|night`, an event `/<prefix>/account/book/<sessionId>` (booking), buying a product `/<prefix>/checkout?sku=<sku>` (commerce guest checkout, no sign-in needed; member prices need sign-in), gift vouchers `/<prefix>/gift` (commerce). A visitor without a customer session who opens a portal link goes through the magic-link sign-in and returns to that URL (`callbackUrl`).
32. A member-only session shows a "Members only" badge; its booking button still links to the portal, where booking enforces eligibility. Public pages are cached and never personalised, so they never show a button that fails for the viewer's status: on a lead-magnet session during the lead window (R2) the button reads "Check your access" and the portal page shows "Opens for you on <date>" (scenario 3).

Opening hours, closures and events by stable link
57. `/<prefix>/events/<sessionId>` is a stable link used by forms CTAs, emails and automations: the resolver answers 307 to the session's event page when one is published in that locale, otherwise to `/<prefix>/account/book/<sessionId>`; an unknown or non-event session id answers 404.
58. The `contact_details` block with `showOpeningHours` renders the weekly hours from `settings.business_hours` and, below them, every day of the next 30 days that `booking.getOpeningHours(db, { from: today, to: today + 30 days })` returns with an `exceptionName` (`opensAt = null`: "Closed: <name>"; otherwise "<name>: <opensAt>-<closesAt>"). The site never reads `session_exceptions` itself. The home JSON-LD carries `openingHoursSpecification` from the same weekly hours and `specialOpeningHoursSpecification` for those exceptions.
59. When `settings.business_hours` is empty the opening-hours part is hidden and `/admin/site` lists the issue `opening_hours_missing`.

Legal, consent and analytics
33. The privacy notice must contain the controller's legal name from `settings.company.legal_name` (seeded `Vibrant Lifestyle Collective BV`) in every locale; publish fails otherwise.
34. The current terms are the `terms` page's live version. `recordTermsAcceptance()` is idempotent on its key and writes activity event `site.terms_accepted`.
35. When a terms version with `is_material_change = true` is published, every customer whose latest `terms` acceptance (over `crm.resolvePersonIds`) is for a version older than the latest material version sees a non-blocking banner on all portal pages until they accept; the banner is rendered by `PortalSiteChrome`, which site's portal layout `account/layout.tsx` mounts inside platform's `PortalShell`. Bookings with existing credit are never blocked by it.
36. The cookie banner offers "Accept all", "Reject all" and "Choose" with equal visual weight; no box is pre-ticked; categories are `necessary` (always on, not a choice), `analytics`, `marketing` (R3 tags).
37. No analytics script (Vercel Analytics, Google Analytics) is requested before analytics consent. GA4 loads only on public site pages, only in production (`VERCEL_ENV = 'production'`), only when `settings.site.analytics_enabled` and `ga_measurement_id` are set; it is initialised with Consent Mode v2 `analytics_storage: 'granted'`, `ad_storage`, `ad_user_data`, `ad_personalization: 'denied'` (granted only with marketing consent from R3). Vercel Analytics loads on site pages and, through `PortalSiteChrome`, on portal pages after analytics consent (the portal reads the same `beam_consent` cookie and shows a "Cookie settings" link, never a second banner when a choice exists; without a choice the portal shows the banner like the site). The admin never loads analytics. Every third-party script (GA4 `gtag/js`, Vercel Analytics `/_vercel/insights/script.js`, and from R3 the Google Ads tag and the Meta pixel `https://connect.facebook.net/en_US/fbevents.js`) is loaded only through `next/script` with the request nonce (`headers().get('x-nonce')` read in the server layout and passed to the client loader), so platform's CSP `'strict-dynamic'` (PL-67) admits it; no inline snippet without the nonce exists.
38. The consent cookie lives 182 days. The banner reappears when it is older, when it is missing, or when a cookie-notice version with `is_material_change = true` was published after the version stored in the cookie (its ordinal is higher). "Cookie settings" in the footer reopens the choice at any time; withdrawing deletes `_ga*` cookies set on the site domain.
39. Every banner choice writes one `cookie_consents` row; the cookie holds only `{k, v, a, m, t}` (key, banner version, analytics, marketing, epoch seconds).
40. UTM parameters and the landing path are kept in `sessionStorage` for the visit only after analytics consent; without consent they are passed to a form only when the form is on the landing page itself.

Company identification, accessibility statement and house rules
60. Every public page footer shows the company identification from `settings.company` (Belgian Code of Economic Law, book XII): `legal_name`, the registered `address`, the enterprise number derived from `vat_number` (`BE 0123.456.789`), `support_email` and `phone`. Missing `legal_name`, `address` or `vat_number` in production puts a red go-live banner on `/admin/site` (`company_identification_missing`).
61. One non-archived legal page with `legal_key = 'accessibility_statement'` exists before go-live (European Accessibility Act, which covers online booking and sales to consumers); it states WCAG 2.1 AA conformance (platform PL-90), known exceptions, the date of the last check and a contact email; the footer `legal` menu and platform's sign-in screens link it through `getLegalLinks()`. Its absence is a red go-live banner like the other legal pages.
62. The `terms` document has these chapters (the seed writes them as `h2` sections and the go-live runbook checks them; BEAM supplies the legal text): general conditions, house rules, health self-declaration ("I have no medical reason not to use the sauna and the facilities, or I asked my doctor"), cancellation policy, no right of withdrawal for date-specific leisure bookings (Belgian Code of Economic Law art. VI.53, 12°) next to the 14-day withdrawal for undated purchases (commerce), and membership conditions (interval, renewal, cancel at period end, dunning; credits rule 57a). Accepting the terms at checkout (commerce, context `checkout`, `refType = 'order'`, which covers a membership purchase), at the first booking (booking R62, context `booking`) or in the portal accepts every chapter of the version in force. Health declarations with answers (contraindications) are never collected by the site; they are forms' seeded `health-declaration` form (`acknowledgement` and sensitive fields, 365-day validity through `forms.hasValidSubmission`).
67. The `guardian_consent` legal page is the parental consent document a guardian signs at reception for a minor; crm's `person_declarations` rows reference its live version through `getCurrentLegalVersion(db, 'guardian_consent')`. Site stores no guardian acceptance (crm does); the page is `noindex`, linked from the footer `legal` menu, and missing in production is a red go-live issue like the other legal pages.

Referral links (R3)
63. A visit with `?ref=<CODE>` (8 characters from `A-HJ-NP-Z2-9`) stores the code in cookie `beam_ref` (`Max-Age=2592000`, 30 days, `Secure; SameSite=Lax; Path=/`, category `marketing`) only when marketing consent exists; without consent the code is appended to the portal sign-in, checkout and form links of that page view only. `readReferralCode(cookies, searchParams)` in `api.ts` returns the code for crm (at person creation, also for persons created by forms' submit routes, which run on the same origin and carry the cookie), commerce and platform sign-up; the first code wins and is never overwritten while the cookie lives.

Claude-assisted editing
41. Asking Claude requires `site.edit` and `ai.use`. One active request per page; a second returns `conflict`.
42. Claude receives the base version's content, the instruction, the block schema, brand voice from `settings.site.brand_voice`, and reference lists (product ids and names, upcoming event session ids and titles, form slugs, page ids and titles). It receives no personal data; the `ai_requests.fields_sent` value is `['page_content','instruction','catalogue_refs']`.
43. Claude's output must parse as `ProposalOutput`; one repair round is allowed; a second failure ends the request with `invalid_output` and no version.
44. The proposal keeps the ids of blocks it keeps or changes; new blocks get new ids. It may not change `pages.kind`, `legal_key`, `session_id` or remove a locale from `locales`.
45. Review warnings (non-blocking, shown on the diff) flag: a currency amount in text, a changed path, removed blocks, a changed legal page, text longer than limits.
46. A proposal is either published, rejected with a reason, or copied into the draft ("Edit as draft"); it is never edited in place.

Portal home and portal chrome
47. Every portal query filters on `ctx.actor.personId` (and `crm.resolvePersonIds` where append-only rows are read). Account home shows at most 5 upcoming bookings (own and guest bookings made by the person), credit balances per kind with the nearest expiry, the membership summary, open waitlist offers with their expiry, and quick actions (Book a day session, Book a night, Buy a package, Invite a guest, View invoices, Communication preferences, My details).
48. Each home card loads independently (`Result<T>`); a failing module api shows "Temporarily unavailable" on that card only, logs to Sentry, and the page still renders with status 200.
49. Profile, preferences, bookings, packages, membership, invoices and webinars are pages of crm, email, booking, credits, finance and webinar; the home only links to them. Site's portal layout (`account/layout.tsx`, taken over from platform-P6's first version in Wave 1) calls `requireCustomer()`, wraps every portal page in platform's `PortalShell` and mounts `PortalSiteChrome`; `PortalShell` renders the navigation from every module's `nav.ts` entries with `audience: 'customer'`; site's `nav.ts` declares one such entry, `account` (Home, order 0).

Accessibility and performance
50. Every public and portal page meets WCAG 2.1 AA: `lang` equals the locale, skip link, landmarks, visible focus, keyboard-operable menus and dialogs, reduced-motion respected, contrast from `packages/ui` tokens, no axe violations of impact `serious` or `critical` in the e2e suite.
51. Budgets at p75 on mobile: LCP <= 2.5 s, CLS <= 0.1, INP <= 200 ms; first-load JavaScript on content pages <= 120 KB gzip. Images use `next/image` with stored width and height.

WordPress migration
52. Only WXR items with status `publish` default to `import`; drafts and private items default to `skip`. Imported pages and posts are created as drafts (single version, `created_by = 'user'`, `created_by_user_id` = importer) and need a human publish.
53. Every imported item's old path gets a redirect to its new page (or `redirect_only` target); every imported attachment's old URL redirects to its file URL. The import screen lists every old path that resolves to neither a page nor a redirect.
64. The first apply of an import inserts the redirect `/feed` -> `/nl/feed.xml` (`source = 'wordpress'`, `on conflict (from_path) do nothing`). The resolver answers 410 Gone for the prefix-less paths in `LEGACY_GONE_PREFIXES = ['/wp-admin', '/wp-login.php', '/xmlrpc.php', '/wp-json', '/wp-includes']` (`packages/core/src/site/paths.ts`) after `proxy.ts` has added the locale prefix. The apex `beam.be` redirects to `https://www.beam.be` at the Vercel domain level (runbook).
65. A WXR file over 10 MB is refused; the runbook tells BEAM to export pages, posts and media separately from WordPress (Tools, Export, per content type) and run one import per file. Items already imported by an earlier import (same `wp_link`) are skipped with message "already imported".
66. `wordpress_imports.status`: `uploaded -> parsing -> parsed -> applying -> done`, and `parsing|applying -> failed` (invalid XML, or an apply chunk that ends `dead`). `retryImportErrors` (`site.publish`) moves a `done` or `failed` import back to `applying`, resets its `error` items to `pending` and enqueues `site.apply_wordpress` offset 0; nothing else leaves `done`. `wordpress_import_items.status`: `pending -> imported|skipped|error`, `error -> pending` only through `retryImportErrors`.

## 4. Server surface

File layout (decided so packages never share a file): `modules/site/actions.ts`, `queries.ts`, `jobs.ts` and `api.ts` are barrels created once by P1 that re-export `actions/<area>.ts`, `queries/<area>.ts`, `jobs/<area>.ts` and `server/<area>.ts`; each area file is owned by one package.

### Core types (`packages/core/src/site/`)

```ts
type Link = { kind: 'page'; pageId: string } | { kind: 'url'; href: string } | { kind: 'portal'; route: PortalRoute };
type Block =
  | { id; type: 'hero'; heading: string; subheading?: string; mediaId?: string; cta?: { label: string; link: Link } }
  | { id; type: 'rich_text'; doc: RichDoc }
  | { id; type: 'image'; mediaId: string; caption?: string }
  | { id; type: 'image_text'; mediaId: string; doc: RichDoc; imageSide: 'left'|'right' }
  | { id; type: 'cta'; heading: string; text?: string; button: { label: string; link: Link } }
  | { id; type: 'card_grid'; heading?: string; cards: { heading: string; text: string; mediaId?: string; link?: Link }[] }   // 1-12 cards
  | { id; type: 'faq'; heading?: string; items: { question: string; answer: RichDoc }[] }                                    // 1-30 items
  | { id; type: 'pricing_table'; heading?: string; productIds: string[]; showMemberPrice: boolean }                          // 1-12 products
  | { id; type: 'events_list'; heading?: string; limit: number; showFull: boolean }                                          // limit 1-24
  | { id; type: 'availability_preview'; kind: 'day'|'night'; days: number }                                                  // days 1-14
  | { id; type: 'posts_list'; heading?: string; limit: number; paginate: boolean }
  | { id; type: 'form_embed'; formSlug: string }
  | { id; type: 'booking_cta'; label: string; target: { kind: 'book_day'|'book_night' } | { kind: 'session'; sessionId: string } | { kind: 'buy_product'; productId: string } | { kind: 'gift' } }
  | { id; type: 'video'; youtubeId: string; title: string; posterMediaId: string }                                         // youtubeId /^[A-Za-z0-9_-]{11}$/
  | { id; type: 'testimonial'; quote: string; authorName: string; authorDetail?: string; consentConfirmed: true }
  | { id; type: 'contact_details'; showAddress: boolean; showPhone: boolean; showEmail: boolean; showOpeningHours: boolean }
  | { id; type: 'map'; mediaId: string; linkUrl: string }
  | { id; type: 'legal_meta' }                                    // "Version n, last updated <date>"; legal pages only
  | { id; type: 'webinar_signup'; webinarId: string };            // R2: rendered by webinar's `WebinarSignup({ webinarId, locale })` (card linking to /<prefix>/webinars/<slug>)
```

Pure functions: `BlocksByLocale` (Zod), `parseBlocks(locale, json): Block[]`, `normalisePath(raw): string`, `isReservedPath(path): boolean`, `isLegacyGone(path): boolean`, `parseStableEventPath(segments): string | null` (rule 57), `enterpriseNumber(vatNumber): string | null` (rule 60), `bandFor(availability: { bookable: number; capacity: number; reason: string }): 'available'|'few'|'full'` (rule 30), `localeFromPrefix('nl'|'fr'|'en'): Locale`, `prefixFromLocale(Locale)`, `checkPublishable(version: VersionContent, refs: RefFacts): PublishIssue[]` (`PublishIssue = { locale?: Locale; blockId?: string; code: string; message: string }`), `collectRefs(version): { mediaIds; formSlugs; productIds; sessionIds; pageIds; webinarIds }`, `diffVersions(base: VersionContent | null, next: VersionContent): VersionDiff` (pairs blocks by `id`; per field `{ op: 'eq'|'ins'|'del'; text }[]` from a word-level LCS `diffWords(a, b)`), `reviewWarnings(base, next): Warning[]`, `buildJsonLd(kind, facts): object[]`, `encodeConsentCookie / decodeConsentCookie`, `imageSize(bytes: Uint8Array): { width; height; mime } | null` (PNG, JPEG, WebP, GIF headers; anything else returns null and the upload is refused), `richDocToPlainText(doc)`.

### Server actions (all `action({...})`, audit domain `site`)

| Action (`name`) | Audience, permission | Input (Zod) | Output | Audit action / events |
| --- | --- | --- | --- | --- |
| `createPage` (`site.page.create`) | staff, `site.edit` | `{ kind, slug, title: LocalizedText partial, locales: Locale[], legalKey?, sessionId? }` | `{ pageId, versionId }` | `site.page.create` |
| `saveDraft` (`site.page.save_draft`) | staff, `site.edit` | `{ pageId, versionId?, expectedUpdatedAt?, title, paths, blocks, seo, excerpt?, coverMediaId?, locales, isMaterialChange, changeSummary? }` | `{ versionId, updatedAt, issues: PublishIssue[] }` | `site.page.save_draft` (old/new digest only, not full JSON) |
| `createDraftFromVersion` | staff, `site.edit` | `{ pageId, fromVersionId, replaceExisting: boolean }` | `{ versionId }` | `site.page.restore` |
| `discardDraft` | staff, `site.edit` | `{ versionId }` | `{ ok }` | `site.page.discard_draft` |
| `publishVersion` (`site.page.publish`) | staff, `site.publish` | `{ versionId, scheduleAt?: string (ISO) }` | `{ publishedAt } \| { scheduledAt }` or `validation` with `issues` | `site.page.publish` or `site.page.schedule` |
| `cancelScheduledPublish` | staff, `site.publish` | `{ versionId }` | `{ ok }` | `site.page.unschedule` |
| `unpublishPage` | staff, `site.publish` | `{ pageId, redirectTo?: Link }` | `{ ok }` | `site.page.unpublish` |
| `archivePage` | staff, `site.publish` | `{ pageId, redirectTo?: Link }` | `{ ok }`; open proposals become `rejected` (rule 55), pending Claude requests `cancelled` | `site.page.archive` |
| `restoreArchivedPage` | staff, `site.publish` | `{ pageId }` | `{ ok }` or `conflict` naming the page that holds the slug, kind, legal key or session (rule 54) | `site.page.restore_archived` |
| `updateNavMenu` | staff, `site.publish` | `{ key, items: NavItem[], expectedVersion }` | `{ version }` | `site.nav.update` (old/new items) |
| `upsertRedirect` | staff, `site.publish` | `{ id?, fromPath, to: { pageId, locale } \| { url }, isPermanent }` | `{ id }` | `site.redirect.upsert` |
| `deleteRedirect` | staff, `site.publish` | `{ id }` | `{ ok }` | `site.redirect.delete` |
| `uploadMedia` | staff, `site.edit` | `FormData { file (<= 10 MB, allowed mime), alt: LocalizedText partial, isDecorative }`; stores the bytes with platform's `storeFile(ctx, { kind: 'image', isPublic: true })` | `{ mediaId, fileId }` | `site.media.upload` |
| `updateMedia` | staff, `site.edit` | `{ mediaId, alt, isDecorative, caption?, credit? }` | `{ ok }` | `site.media.update` |
| `deleteMedia` | staff, `site.edit` | `{ mediaId }` | `{ ok }` or `conflict` when referenced by a draft, proposal or live version | `site.media.delete` |
| `requestProposal` (`site.proposal.request`) | staff, `site.edit` + `ctx.require('ai.use')` | `{ pageId, instruction (3-4000), locales?: Locale[], kind: 'edit'\|'new_page' }` | `{ editRequestId }`; enqueues `site.propose_page` | `site.proposal.request` |
| `cancelProposalRequest` | staff, `site.edit` | `{ editRequestId }` | `{ ok }` (only while `pending`) | `site.proposal.cancel` |
| `rejectProposal` | staff, `site.edit` | `{ versionId, reason (1-500) }` | `{ ok }` | `site.proposal.reject` |
| `copyProposalToDraft` | staff, `site.edit` | `{ versionId, replaceExisting: boolean }` | `{ versionId }`; the proposal becomes `superseded` | `site.proposal.copy_to_draft` |
| `startWordpressImport` | staff, `site.publish` | `FormData { file (.xml, <= 10 MB), siteOrigin, defaultLocale }` | `{ importId }`; enqueues `site.parse_wordpress` | `site.wp_import.start` |
| `updateImportItem` | staff, `site.publish` | `{ itemId, decision, locale?, translationGroup?, redirectToPageId? }` | `{ ok }` | `site.wp_import.update_item` |
| `applyWordpressImport` | staff, `site.publish` | `{ importId }` (status `parsed`) | `{ ok }`; enqueues `site.apply_wordpress` offset 0 | `site.wp_import.apply` |
| `retryImportErrors` | staff, `site.publish` | `{ importId }` (status `done` or `failed`) | `{ retried: number }`; rule 66 | `site.wp_import.retry` |
| `publishImportedPages` | staff, `site.publish` | `{ importId }` | `{ published: number, blocked: { pageId, issues }[] }` | `site.page.publish` per page |
| `acceptCurrentTerms` (`site.terms.accept`) | customer | `{ versionId }` (must equal the current `terms` version, else `conflict` "newer terms published, reload") | `{ ok }` | event `site.terms_accepted` (context `portal_prompt`) |

### Queries (`queries/<area>.ts`; read through `getDb()`, public ones wrapped in `unstable_cache` with tags)

- Public: `getPageByPath(locale, path): Promise<ResolvedPage | null>` (tags `site:routes`, `site:page:<id>`), `resolveRequest(locale, segments, searchParams): Promise<{ kind: 'page'; page } | { kind: 'redirect'; to; permanent } | { kind: 'gone' } | { kind: 'not_found' }>`, `getNavMenus(locale)` (tag `site:nav`), `listPublicEventsForSite(locale, { page, limit, showFull })` (revalidate 300, tag `site:events`), `listPosts(locale, { page, limit })`, `getPricingRows(productIds, locale)` (revalidate 300, tag `site:prices`), `getSitemapEntries()` (tag `site:sitemap`), `getLegalLinks(locale)`, `getOpeningHours(locale)` (revalidate 300, tag `site:hours`; weekly hours from `settings.business_hours` plus `booking.getOpeningHours()` exceptions of the next 30 days, rule 58), `getCompanyFooter(locale)`.
- Admin: `listPagesForAdmin({ kind?, status?, q? })`, `getPageEditor(pageId)`, `getVersion(versionId)`, `getVersionDiff(versionId)`, `listVersionHistory(pageId)`, `getEditRequest(id)` (polled every 2 s by the Claude panel), `listMedia({ q?, cursor })`, `listRedirects({ q?, source?, cursor })`, `getContentIssues()`, `getWordpressImport(id)`, `listWordpressImportItems(importId, filter)`, `getRedirectCoverage(importId)`.
- Portal: `getAccountHome(personId, locale)`, `getTermsBannerState(personId)` (both uncached, `Cache-Control: private, no-store`).

### Route handlers and metadata routes

| Route | Method | Behaviour |
| --- | --- | --- |
| `app/[locale]/(site)/[[...path]]/page.tsx` | GET | resolves path (stable event link rule 57 and legacy-gone rule 64 first), renders page or redirects (308/307), 404, 410; `generateMetadata` from `seo[locale]`, canonical, `alternates.languages` (hreflang for each live locale plus `x-default` = nl-BE or first locale); `revalidate = 3600` |
| `app/[locale]/(site)/preview/[versionId]/page.tsx` | GET | staff session with `site.edit` required (checked in the page, `notFound()` otherwise); renders any version; `robots: noindex`; `Cache-Control: private, no-store` |
| `app/[locale]/(site)/unavailable/page.tsx` | GET | "not available in your language" with links to the page's live locales (`?page=<pageId>`) |
| `app/[locale]/(site)/offline/page.tsx` | GET | static offline fallback, precached by the service worker |
| `app/[locale]/(site)/feed.xml/route.ts` | GET | RSS 2.0 of the latest 20 posts in the locale |
| `app/sitemap.ts` | GET | every live route of indexable pages, with `alternates.languages`, `lastModified = published_at`; excludes `noindex`, past events after 30 days and legal pages marked noindex |
| `app/robots.ts` | GET | production: `Allow: /`, `Disallow: /admin, /api, /*/account, /*/preview`, `Sitemap: <origin>/sitemap.xml`; other environments `Disallow: /` |
| `app/manifest.ts` | GET | PWA manifest (section 5) |
| `app/pwa-icon/[size]/route.tsx` | GET | 192, 512 and 512-maskable PNG via `ImageResponse`, until BEAM supplies brand PNGs in `public/icons/` |
| `app/api/public/cookie-consent/route.ts` | POST | body `{ consentKey?: uuid, action, choices: { analytics: boolean, marketing: boolean }, bannerVersion: int, locale }`; inserts `cookie_consents`, sets cookie `beam_consent` (`Secure; SameSite=Lax; Path=/; Max-Age=15724800`, readable by JS), returns `{ consentKey }`; rate-limited by the WAF rule on `/api/public/*` |

### Jobs (`defineJob`, `jobs/<area>.ts`)

| Kind | Lane, priority | Idempotency key | Attempts, timeout | Behaviour |
| --- | --- | --- | --- | --- |
| `site.propose_page` | fast, 5 | `page_edit:<edit_request_id>:propose` | 3, 120 s | no-op if the request is not `pending`/`running` or already has `result_version_id`; sets `running`; fails the request with `page_archived` when the page is archived; calls `callClaude(ctx, { feature: 'site.propose_page', model: 'opus', outputSchema: ProposalOutput, fieldsSent, maxTokens: 16000 })`; validates; one repair call; inserts the `proposed` version and sets the request `succeeded` in one transaction. `PermanentError('budget')` from platform and `invalid_output` end the request `failed` (`budget_exceeded`, `invalid_output`); provider 5xx and timeouts are `RetryableError`; on the last failed attempt the request becomes `failed` with `ai_unavailable` |
| `site.publish_version` | fast, 3 | `page_version:<version_id>:publish:<schedule epoch seconds>` | 6, 30 s | publishes at `run_at` only if the version is still `draft`/`proposed` and `scheduled_publish_at` equals the payload; failed checks clear the schedule and write audit `site.page.schedule_failed` (no retry) |
| `site.parse_wordpress` | bulk, 9 | `wp_import:<import_id>:parse` | 3, 120 s | sets `parsing`; parses the WXR file into `wordpress_import_items` (upsert on `(import_id, wp_type, wp_id)`), drops authors and comments, sets `parsed` and counts; invalid XML sets `failed` with the line number (`PermanentError`) |
| `site.fetch_wordpress_media` | bulk, 9 | `wp_import:<import_id>:media:<n>` | 6, 120 s | downloads 20 attachments per job through the `wordpress` client, creates `files` (through `storeFile`) + `media_assets` (skip if `wordpress_url` exists), enqueues `n + 1` until done |
| `site.apply_wordpress` | bulk, 9 | `wp_import:<import_id>:apply:<offset>:<attempt round>` (round = number of `retryImportErrors` calls, 0 first) | 6, 120 s | sets `applying`; converts 50 `pending` items per job into pages (draft v1) and redirects, sets item status, enqueues the next offset; the first run of round 0 enqueues `site.fetch_wordpress_media` n = 0 and inserts the `/feed` redirect; the last sets `done`; a dead chunk sets the import `failed` |
| `site.audit_content` (R4) | bulk, 9 | `schedule:site.audit_content:<YYYY-MM-DDTHH:mm>` | 3, 300 s | `callClaude(ctx, { feature: 'site.audit_content', model: 'haiku' })` pass per page for missing or weak SEO texts and broken references; inserts `site_audit_reports` for the week (on conflict do nothing) |

A double run of every job yields the same database state (`jobs.test.ts`).

### Schedules (`schedules.ts`, Europe/Brussels)

V1: none (publishing uses `run_at`). R4: `site.audit_content` every Monday at 07:10 (`10 7 * * 1`).

### Activity events and permissions declared

`events.ts`: `site.terms_accepted` (person; `ref_type = 'page_version'`, `data = { legal_key, context, version_ordinal }`, `dedupe_key = <terms idempotency_key>`). `permissions.ts` declares `site.edit` and `site.publish` (architecture strings; no new permission). `nav.ts` declares the admin group "Website" (`site.edit`) and the customer entry `account` (Home, order 0). `config.ts` declares settings key `site` with the `SiteSettings` Zod schema and defaults.

### Cross-module API (`modules/site/api.ts`)

```ts
export type LegalKey = 'privacy_notice' | 'terms' | 'cookie_notice' | 'accessibility_statement' | 'guardian_consent';
export type TermsContext = 'checkout' | 'signup' | 'booking' | 'portal_prompt' | 'pos' | 'import';
export function getCurrentLegalVersion(db: DbOrTx, key: LegalKey): Promise<{ versionId: string; version: number; publishedAt: Date; requiresReacceptance: boolean; text: LocalizedText; urlByLocale: Partial<Record<Locale, string>> } | null>;
// version = published ordinal from v_legal_versions ("Version n"); requiresReacceptance = the live version's is_material_change;
// text = richDocToPlainText of the live version's blocks per live locale (headings and paragraphs, blank-line separated), for crm's reception print and declarations
export function recordTermsAcceptance(tx: Tx, ctx: Ctx, input: { personId: string; versionId: string; context: TermsContext; refType?: 'order' | 'booking' | 'user'; refId?: string; ip?: string | null }): Promise<{ acceptanceId: string; created: boolean }>;
export function hasAcceptedCurrentTerms(db: DbOrTx, personId: string): Promise<boolean>; // signature confirmed for booking R62 and commerce; over crm.resolvePersonIds; true when the latest acceptance is at or after the latest material terms version; false when no terms version is published
export function getLegalLinks(locale: Locale): Promise<{ privacy: string | null; terms: string | null; cookies: string | null; accessibility: string | null }>; // absolute URLs for email footers and checkout
export function getPageUrl(db: DbOrTx, ref: { pageId: string } | { slug: string }, locale: Locale): Promise<string | null>; // absolute URL or null
export function getEventPageUrl(db: DbOrTx, sessionId: string, locale: Locale): Promise<string | null>; // event page, or the portal booking URL when no page exists
export type PortalRoute = 'home' | 'book_day' | 'book_night' | 'bookings' | 'waitlist' | 'shop' | 'packages' | 'membership' | 'invoices' | 'preferences' | 'profile';
export function portalUrl(locale: Locale, route: PortalRoute, params?: Record<string, string>): string; // site-relative, e.g. /nl/account/book?kind=day
export function getSiteSettings(db: DbOrTx): Promise<SiteSettings>;
export function readReferralCode(cookies: { get(name: string): { value: string } | undefined }, searchParams?: URLSearchParams): string | null; // R3, rule 63; returns null before R3
```

`PortalSiteChrome({ locale })` is internal (`M/ui/portal/site-chrome.tsx`) and mounted by site's own portal layout, so it is not exported from `api.ts`. Module names are the owners' published ones: forms' `FormEmbed`, webinar's `WebinarSignup`.

`SiteSettings` (`settings` key `site`, snake_case like every settings value): `{ canonical_origin: string (default 'https://www.beam.be'); analytics_enabled: boolean (false); ga_measurement_id: string | null (/^G-[A-Z0-9]{4,12}$/); default_og_image_media_id: string | null; social_links: { instagram?, facebook?, linkedin?, youtube? } (https URLs); brand_voice: string (<= 4000); google_ads_conversion_id: string | null (R3, /^AW-[0-9]{6,12}$/); meta_pixel_id: string | null (R3, /^[0-9]{10,20}$/) }`. It is written only through platform's `updateSetting` (`settings.write`, PL-41) on `/admin/settings/site`; the trade name and legal identity come from `settings.company`, never from `site`.

## 5. Screens

All screens use `packages/ui` components. Every list has an empty state, a skeleton while loading (`loading.tsx`) and an `error.tsx` boundary with a retry button and the request id; action errors show the mapped `error.message` inline next to the control that caused them.

### Staff back-office (`/admin/site/...`, nav group "Website" from `nav.ts`, visible with `site.edit`)

| Route | Shows | Actions | Empty / error | Who |
| --- | --- | --- | --- | --- |
| `/admin/site` | Pages table (title in the staff locale, kind, status, live version, draft and proposal badges, last published), content issues panel (blocking publish issues of drafts, scheduled-publish failures, nav items to hidden pages, references to inactive products or past events, `opening_hours_missing`, missing legal pages (privacy notice, terms, cookie notice, accessibility statement, guardian consent) or `company_identification_missing` as a red go-live banner), open Claude requests | filter by kind and status, search, "New page" | "No pages yet: create the home page or import from WordPress" | `site.edit` |
| `/admin/site/pages/new` | Form: kind, slug, title per locale, locales, legal key (legal), session picker (event) | create | slug conflict inline | `site.edit` |
| `/admin/site/pages/[pageId]` | Editor with locale tabs (completeness badge per tab), block list (add, edit, move up/down, duplicate, delete, "copy blocks from nl-BE"), per-block forms with media, link, product, form and session pickers, SEO tab (title and description counters, OG image, noindex), paths, excerpt, cover, material-change switch (legal), issue list from `checkPublishable`, history (versions with state, author or "Claude for <user>", published date, Restore), Claude panel | Save draft (Ctrl+S), Preview (opens `/<prefix>/preview/<versionId>`), Publish now, Schedule, Unpublish, Archive (with redirect picker), Ask Claude | stale-draft banner (rule 16); conflict on save shows "Someone else saved this page; reload" | edit: `site.edit`; publish controls hidden without `site.publish`; Claude panel hidden without `ai.use` |
| `/admin/site/pages/[pageId]/versions/[versionId]` | Side-by-side diff of the version against its `based_on_version_id` (or the live version): locale switch, title, paths, SEO, per-block changes with word-level insertions and deletions, added and removed blocks; review warnings; toggle to rendered previews (two iframes); for Claude versions the instruction, the change summary and the requester | Publish, Schedule, Reject (reason), Edit as draft | "This version is identical to the live version" | view `site.edit`; publish `site.publish` |
| `/admin/site/navigation` | Header, footer and legal menus as editable trees with label per locale and target picker | add, edit, reorder, remove, Save (version check) | "No items: the header shows only the logo" | `site.publish` to save, `site.edit` to view |
| `/admin/site/media` | Grid of images with alt completeness, size, usage count | upload (drag and drop or file picker), edit alt per locale, decorative switch, caption, credit, delete | "No images yet" | `site.edit` |
| `/admin/site/redirects` | Table: from, to, source, permanent, "seen" (approximate hits), last seen | add, edit, delete, filter by source, search, CSV export of the table | "No redirects" | view `site.edit`, change `site.publish` |
| `/admin/site/imports` | WordPress imports with status and counts | upload WXR with site origin and default locale | "No imports" | `site.publish` |
| `/admin/site/imports/[importId]` | Items table (type, WP status, title, old path, locale, translation group, decision, status, message), redirect coverage list, report of stripped shortcodes and unsupported markup | change decision, locale, group, redirect target; Apply import; Retry failed items; Publish complete imported pages | parse errors shown with line numbers | `site.publish` |
| `/admin/site/settings` | Read-only summary of `settings.site` (canonical origin, analytics switch, GA measurement id, default OG image, social links, brand voice for Claude; R3 Google Ads and Meta Pixel ids) and of `settings.company` as shown in the footer | "Edit in settings" links to platform's `/admin/settings/site` and `/admin/settings/company` (`settings.write`) | | `site.edit` |
| `/admin/site/insights` (R3) | Per landing page and UTM campaign: form submissions, new persons, orders and revenue in the period | date range, export CSV | "No tracked landings in this period" | `reports.read` and `site.edit` |

The Claude panel (inside the editor): instruction textarea (character counter), locale checkboxes, "Ask Claude"; while running a progress line polling `getEditRequest` every 2 s for up to 3 minutes; on success "Proposal ready: review" linking to the diff; on failure the decided message per `error_code` ("AI budget reached for this month", "Claude returned an invalid page, try a more specific instruction", "Claude is unavailable, edit manually").

### Customer portal (`/[locale]/account/...`, audience customer)

| Route | Shows | Actions | Empty / error |
| --- | --- | --- | --- |
| `PortalSiteChrome` (mounted by site's `account/layout.tsx` inside platform's `PortalShell` on every portal page) | terms banner (rule 35) with "Read the new terms" and "Accept"; cookie banner only when no choice exists; consent-gated Vercel Analytics; "Cookie settings" link in the portal footer | accept terms, open cookie settings | a failing terms lookup hides the banner (logged to Sentry), never blocks the page |
| `account` (home) | Greeting with first name; next 5 upcoming bookings (date, time, kind, guest marker, link to booking detail); balances per credit kind from `credits.getPersonCreditSummary().byKind` ("4 sessions remaining", `nextExpiresAt`); membership card from `credits.getMembershipSummary()` (status, current period end, included credits, "Renew" link when `past_due`); open waitlist offers with countdown and Claim button; install card (below); quick actions: Book a day session, Book a night, Buy a package, Invite a guest (booking's bookings list), View invoices, Communication preferences, My details (crm profile); R2: upcoming webinars (`webinar.listUpcomingRegistrationsForPerson`), packages shared with me | follow links into booking, commerce, credits, finance and crm pages | "No upcoming bookings: book your first session" with Book button; "No active package" with Buy button |

PWA: `manifest.webmanifest` with `name` = `settings.company.trade_name` (seeded `BEAM Vitality Center`), `short_name: 'BEAM'`, `lang` and `description` per the request locale (`nl-BE` default), `start_url: '/account?source=pwa'`, `scope: '/'`, `display: 'standalone'`, `background_color` and `theme_color` from `packages/ui` tokens, icons 192, 512 and 512 maskable. The service worker (`app/sw.ts`, Serwist) precaches build assets and `/nl/offline`, `/fr/offline`, `/en/offline`; `/_next/static` cache-first; images stale-while-revalidate (7 days, 200 entries); navigations network-first with a 3-second timeout and the offline page as fallback; it never handles `/admin/*`, `/api/*` or non-GET requests, and never serves account pages from cache when the network answers. The install prompt captures `beforeinstallprompt` and shows an "Install the BEAM app" card on account home from the second portal visit; on iOS Safari it shows the "Share, Add to Home Screen" instruction; dismissal is remembered in `localStorage` for 90 days.

### Public (`/[locale]/...`, audience everyone)

| Route | Shows | Notes |
| --- | --- | --- |
| `/[locale]` | home page blocks; JSON-LD `HealthAndBeautyBusiness` (a `LocalBusiness` subtype; `name` = `settings.company.trade_name`, `legalName`, `vatID`, address, `openingHoursSpecification` and `specialOpeningHoursSpecification` (rule 58), logo, `sameAs` from `social_links`) | 404 page with navigation if no home is published |
| `/[locale]/<path>` | any published page: standard, offer, pricing, landing, contact (with `form_embed` of form `contact` and `contact_details`), legal (with `legal_meta`), events index (`events_list`), event detail (session date, time, location, price, availability band, "Get tickets" or "Join the waitlist", JSON-LD `Event`), blog index (`posts_list`, `?page=n`), post (cover, date, JSON-LD `BlogPosting`), FAQ blocks add `FAQPage`, nested paths add `BreadcrumbList` | header and footer from `nav_menus`; footer newsletter `FormBlock` of form `newsletter`; company identification (rule 60); "Cookie settings" link; stable event links `/<prefix>/events/<sessionId>` (rule 57) |
| `/[locale]/unavailable?page=<id>` | "This page is not available in <language>" with links to its live locales | `noindex` |
| `/[locale]/preview/<versionId>` | rendered version with a "Preview, not published" ribbon | staff only |
| Cookie banner and settings dialog | on every public and portal page until a choice exists | dialog is a focus-trapped modal opened from the banner or footer; the banner itself is a non-modal region at the bottom |
| 404 / 410 | localised, with search-free navigation back to home and events | status codes 404 and 410 |

## 6. Integrations

| Service | Client | Calls | Failure handling | Idempotency |
| --- | --- | --- | --- | --- |
| Claude (Anthropic) | `packages/integrations/src/anthropic/` through platform's `callClaude()` (feature keys `site.propose_page` V1 and `site.audit_content` R4 in `AI_FEATURES`); tests use `anthropic/fake.ts` with scripted responses | `site.propose_page` (and `translate` from R4): one call with `model: 'opus'` (`claude-opus-5-5`), stable system prompt marked `cache_control: { type: 'ephemeral' }`, structured JSON output from `z.toJSONSchema(ProposalOutput)`; one repair call on invalid output. R4 `site.audit_content` uses `model: 'haiku'` (`claude-haiku-5-5`) | gateway budget refusal `PermanentError('budget')` -> request `failed` / `budget_exceeded`; 429, 5xx, timeout -> `RetryableError` (backoff 60 s, 300 s), last attempt -> `ai_unavailable`; the editor always works without AI | job key `site:propose:<edit_request_id>`; the result is written only if `result_version_id` is null |
| WordPress (old site) | new `packages/integrations/src/wordpress/client.ts` + `fake.ts`: `class WordpressMediaClient { constructor(opts: { allowedOrigin: string; timeoutMs?: number; maxBytes?: number; onCall: IntegrationCallLogger }); fetchMedia(url: string): Promise<{ bytes: Uint8Array; mime: string; sizeBytes: number }> }` | `site.fetch_wordpress_media`: GET each attachment URL; only URLs on `allowedOrigin` (the import's `site_origin`) or its `/wp-content/uploads/` CDN host listed in the file; 20 s timeout; 10 MB max | 404 or 410 -> item `error` "media missing", continue; mime not allowed -> `error`; 5xx or network -> `RetryableError` for the chunk; every call logged in `integration_calls` (provider `wordpress`, a value platform adds to `integration_calls_provider` in its frozen-file PR; never bodies) | `media_assets.wordpress_url` unique; a re-run skips fetched URLs |
| Google Analytics 4 | browser only: `https://www.googletagmanager.com/gtag/js?id=<id>` loaded through `next/script` with the request nonce by `M/ui/public/analytics-loader.tsx` after consent; the GA hosts are already in platform's PL-67 `connect-src` and `img-src`, and `'strict-dynamic'` admits the nonce'd script, so no CSP change | page views (automatic), no custom events in V1; IP handling is GA4's default (no IP storage) | script load failure is ignored | none |
| Vercel Analytics | browser only: `/_vercel/insights/script.js` loaded through `next/script` with the request nonce by the loader after consent (same origin, `va.vercel-scripts.com` already in PL-67 `connect-src`), so no CSP change and no `@vercel/analytics` package | page views on site and portal | none needed | none |
| YouTube | browser only: `youtube-nocookie.com/embed/<id>` iframe created on click | none server-side | iframe failure shows the link to YouTube | none |
| Google Ads, Meta Pixel (R3) | browser only, marketing consent; both tags (`gtag` conversion with the `AW-` id, `fbevents.js`) loaded through `next/script` with the nonce; CSP: platform's PL-67 R3 addition covers Meta (`https://connect.facebook.net`, `img-src https://www.facebook.com`); site asks the orchestrator to add `https://www.googleadservices.com https://googleads.g.doubleclick.net` to `img-src` and `connect-src` and `https://www.facebook.com` to `connect-src` for R3 | conversion tag on form success (`beam-form:completed` message from `FormBlock`) and on commerce's paid return page through `useConsent()` | ignored | none |
| Better Stack (uptime) | configured in Better Stack, documented in `docs/runbooks/site-go-live.md` | HTTP monitor `GET https://www.beam.be/nl` every 60 s, expects 200 and the keyword from `settings.company.trade_name`, alert after 2 failures to `#beam-alerts`; counts towards the 99.5 % monthly uptime target in the monthly report | Critical severity when the public site is down (booking entry) | none |

The site makes no other server-side external calls. Images are served by the platform's `/api/public/files/[id]` and optimised by `next/image` on Vercel.

Integration classification (blueprint 50 asks Sidestream to state the type of every integration; the owning module builds it):

| Integration | Type | Owner, release | What it does |
| --- | --- | --- | --- |
| Meta | API-based, read-only (Marketing API); browser tag after marketing consent; webhook-based inbox | ops R3 (ads data), site R3 (Pixel), crm R3 (Instagram and Messenger inbox) | spend and leads per campaign; conversion events; messages into the unified inbox |
| Google Ads | API-based, read-only; browser tag after marketing consent | ops R3, site R3 | spend per campaign; conversion tag |
| Google Analytics | browser tag, consent-gated (GA4, Consent Mode v2) | site V1 | page views; UTM stays in BEAM's own lead data |
| WordPress | replaced by the native site; temporary one-time WXR file import | site V1 (import), retired at the week-8 DNS switch | pages, posts, media and redirects |
| Zoom, WebinarGeek | temporary until the native webinar (R2): CSV import presets plus a signed generic JSON webhook | ops V1 (imports, webinar spec decision 11), retired at the R2 switch-over | registrations and attendance on the timeline |
| Zapier | automation-platform based, temporary: feeds the V1 webinar stopgap webhook; outbound calls from BEAM use the automation `webhook` step (custom-built HTTPS POST to allow-listed hosts) | ops V1, automation V1 | bridge to tools without an API client |
| Mollie | API + webhooks | commerce V1 | payments, mandates, terminal, refunds |
| Stripe | API + webhooks, adapter behind `PaymentProvider` | commerce (stub V1, switchable per channel) | alternative provider |
| Billit | API-based | finance V1 | invoices, credit notes, Peppol |
| Social channels | native links (footer `social_links`), embeds only by click-to-load | site V1; crm R3 inbox | outbound links; no tracking widgets |
| Other future APIs | custom-built adapters in `packages/integrations/src/<provider>/` with `client.ts` and `fake.ts` | per module | same pattern as above |


## 7. Permissions and audit

| Role (default set) | site.edit | site.publish | ai.use | Can do |
| --- | --- | --- | --- | --- |
| owner, technical_admin, management | yes | yes | yes | everything in this module |
| marketing | yes | yes | yes | everything in this module |
| customer_service, sales, finance, reception, external_partner | no | no | sales: yes | nothing in `/admin/site` (nav hidden, server refuses) |
| customer | n/a | n/a | n/a | own account home, accept terms, cookie choice (profile belongs to crm) |
| anonymous visitor | n/a | n/a | n/a | public pages, cookie choice |

Rules: viewing any `/admin/site` screen requires `site.edit`; publishing, scheduling, unpublishing, archiving, restoring, navigation, redirects and WordPress import require `site.publish`; editing `settings.site` requires platform's `settings.write`; Claude requests require `site.edit` and `ai.use`; the R3 insights screen also requires `reports.read`. Customers' actions are scoped to `ctx.actor.personId`.

Audited (`audit_log`, written by the `action()` wrapper with old and new values): every action in section 4 with its audit action name: `site.page.create`, `site.page.save_draft` (old/new store `{ versionId, sha256 of content }`, not the content), `site.page.restore`, `site.page.discard_draft`, `site.page.publish`, `site.page.schedule`, `site.page.unschedule`, `site.page.schedule_failed` (system actor), `site.page.unpublish`, `site.page.archive`, `site.page.restore_archived`, `site.nav.update`, `site.redirect.upsert`, `site.redirect.delete`, `site.media.upload`, `site.media.update`, `site.media.delete`, `site.proposal.request`, `site.proposal.cancel`, `site.proposal.reject`, `site.proposal.copy_to_draft`, `site.wp_import.start`, `site.wp_import.update_item`, `site.wp_import.apply`, `site.wp_import.retry`. Publishing a Claude version records `new_value.created_by = 'claude'` and the `edit_request_id`, so "who approved which AI text" is answerable from the audit log. Customer actions are not staff writes and are not audited; `acceptCurrentTerms` leaves the `terms_acceptances` row and the timeline event instead.

## 8. Multi-language and content

Content fields (staff-edited, stored in the database):
- Per-locale structures (one value per locale, not `LocalizedText` objects inside): `page_versions.blocks`, `page_versions.seo`, `page_versions.paths`. Inside a locale's block list every text is a plain string in that locale.
- `LocalizedText` jsonb: `page_versions.title`, `page_versions.excerpt`, `media_assets.alt`, `media_assets.caption`, `nav_menus.items[].label`.
- Not translated: `pages.slug` (internal), `redirects`, `settings.site.brand_voice` (English, read by Claude).

Publish-time completeness (blocking, for every locale in `version.locales`): the checks of rule 5, plus `assertComplete(title, locales)`, `assertComplete(excerpt, locales)` where required, `assertComplete(media.alt, locales)` for each referenced non-decorative image, and the legal-name check of rule 33. Saving a navigation menu calls `assertComplete(label, ['nl-BE','fr-BE','en'])` for every item (menus serve all three locales; an item for a page missing a locale is hidden there, rule 24). A page may declare fewer locales; a visitor of another locale gets `/[locale]/unavailable`, never a mixed page. Dates use `Intl.DateTimeFormat(locale, { timeZone: 'Europe/Brussels' })`, money `Intl.NumberFormat` EUR. The locale switch links to the same page's route in the target locale, or to `unavailable` when it has none.

UI strings: namespace `site` in `packages/core/src/i18n/messages/{en,nl-BE,fr-BE}/site.json`, keys `site.<screen>.<element>`, `en` the source. P1 writes the complete V1 key set in all three locales; R2-R4 packages add their keys. Key groups (each group lists every key P1 must create):
- `site.public.*`: `skipLink`, `menu.open`, `menu.close`, `localeSwitch.label`, `footer.cookieSettings`, `footer.legal`, `footer.newsletterHeading`, `footer.enterpriseNumber` (`Enterprise number {number}`), `footer.vat` (`VAT {number}`), `footer.social`, `notFound.title`, `notFound.body`, `notFound.home`, `gone.title`, `gone.body`, `unavailable.title`, `unavailable.body`, `offline.title`, `offline.body`, `preview.ribbon`, `breadcrumb.home`.
- `site.blocks.*`: `pricing.from`, `pricing.members`, `pricing.vatIncluded`, `pricing.sessions` (ICU plural), `pricing.validity` (plural days), `events.empty`, `events.full`, `events.fewLeft`, `events.available`, `events.membersOnly`, `events.getTickets`, `events.joinWaitlist`, `events.checkAccess`, `events.past`, `events.cancelled`, `events.more`, `gift.cta`, `availability.title`, `availability.book`, `availability.none`, `posts.empty`, `posts.readMore`, `posts.newer`, `posts.older`, `video.play` (with `{title}`), `video.consentNote`, `map.open`, `legal.version` (`Version {n}`), `legal.updated` (`Last updated {date}`), `contact.address`, `contact.phone`, `contact.email`, `contact.openingHours`, `contact.closed`, `contact.weekday.<1-7>`, `contact.closures`, `contact.closedOn` (`Closed: {name}`), `contact.specialHours` (`{name}: {opens}-{closes}`).
- `site.cookies.*`: `banner.title`, `banner.body`, `banner.acceptAll`, `banner.rejectAll`, `banner.choose`, `dialog.title`, `dialog.necessary.title`, `dialog.necessary.body`, `dialog.analytics.title`, `dialog.analytics.body`, `dialog.marketing.title`, `dialog.marketing.body`, `dialog.save`, `dialog.noticeLink`.
- `site.portal.*`: `nav.home` (the one customer nav entry site declares; sign-out and the other entries belong to platform and their modules), `home.greeting` (`{firstName}`), `home.upcoming`, `home.noBookings`, `home.bookFirst`, `home.guest`, `home.balance`, `home.remaining` (plural per kind: day sessions, nights, euro credit), `home.expires`, `home.noPackage`, `home.buyPackage`, `home.membership`, `home.membershipActive`, `home.membershipPastDue`, `home.renew`, `home.offers`, `home.offerExpires`, `home.claim`, `home.quick.bookDay`, `home.quick.bookNight`, `home.quick.buyPackage`, `home.quick.inviteGuest`, `home.quick.invoices`, `home.quick.preferences`, `home.quick.profile`, `home.unavailableCard`, `terms.banner`, `terms.read`, `terms.accept`, `terms.newer`, `install.title`, `install.body`, `install.button`, `install.ios`, `install.dismiss`, `chrome.cookieSettings`. (R2 keys `home.webinars`, `home.sharedWithMe` and `events.priorityUntil` are added by site-P8.)
- `site.admin.*`: navigation labels (`nav.website`, `nav.pages`, `nav.navigation`, `nav.media`, `nav.redirects`, `nav.imports`, `nav.settings`), page kinds (`kind.<each pages_kind>`), statuses and states, block type names and field labels (`block.<type>.name`, `block.<type>.<field>`), editor controls, issue codes (`issue.<code>` for every `PublishIssue.code`), warning codes, Claude panel texts and error codes, diff labels, media, redirects, import, settings and empty states. The admin catalogue is complete in `en`, `nl-BE` and `fr-BE` like every other namespace.

Content seeded by `packages/db/src/seed/site.ts` (development and demo only; BEAM writes real content, proposal section 2): pages `home`, `about`, `day-sessions`, `nights`, `memberships`, `pricing`, `events`, `blog`, `contact`, `privacy`, `terms` (with the chapters of rule 62), `cookies`, `accessibility`, `guardian-consent` with placeholder text in all three locales, each with a published version 1 (`created_by = 'user'`, `published_at` = seed time) and live `page_routes`, so `getCurrentLegalVersion(db, 'terms')` is non-null in `beam_dev`, previews and every `createTestDb()` that runs the seed, and commerce's checkout works in tests; plus the three menus and the `site` settings defaults. The seed is idempotent (`on conflict (slug) do nothing`). In production the seed creates nothing; content comes from the WordPress import and staff.

## 9. Privacy

`modules/site/privacy.ts` registers:

```ts
export const sitePrivacy = {
  tables: ['terms_acceptances', 'cookie_consents'],
  noPiiTables: ['pages', 'page_versions', 'page_routes', 'redirects', 'nav_menus', 'media_assets', 'page_edit_requests', 'wordpress_imports', 'wordpress_import_items', 'site_audit_reports'],
  // export and erase run for every id in crm.resolvePersonIds(personId): append-only rows keep the merged-away person id
  export: async (tx, personId) => ({
    'site/terms_acceptances.json': rows(/* legal_key, version ordinal, accepted_at, context, ref_type, ref_id, ip */),
    'site/cookie_consents.json': rows(/* recorded_at, action, choices, banner_version, locale (no ip_hash, no consent_key) */),
  }),
  erase: async (tx, personId) => [
    { table: 'terms_acceptances', action: 'anonymised', rows: n },   // ip set to null, row kept
    { table: 'cookie_consents', action: 'deleted', rows: m },
  ],
} satisfies PrivacyModule;
```

- Person data: `terms_acceptances` (person_id, ip), `cookie_consents` (person_id, ip_hash). No sensitive (Article 9) column exists in this module; the block schema has no field for health data, and Claude never receives personal data (rule 42).
- Erase runs in its own transaction under `SET LOCAL beam.allow_rewrite = 'on'` (both tables are APPEND) at the `site` position of ops' `ERASE_ORDER` (after `finance`, before `ops`, `crm` and `platform`), so it runs before crm anonymises `persons`; it depends on no module that runs after it. `terms_acceptances` is kept and anonymised because it proves which contract terms applied to orders and invoices that Belgian law requires BEAM to keep for 7 years; its `person_id` then points to the anonymised "Deleted person" row and the IP is removed. `cookie_consents` rows are deleted: the visitor's choice lives in their own browser and the log is only evidence while the consent is in force.
- Anonymous visitors: `cookie_consents` rows without `person_id` are found by `consent_key` only and are covered by retention, not by erasure.
- Staff instructions to Claude (`page_edit_requests.instruction`) and AI prompts are content, not customer data; staff are told in the editor "Do not paste customer details". `ai_requests` are deleted after 30 days by platform.
- WordPress import never stores authors, author emails or comments (rule 52 and section 2).
- Testimonials are content published with the quoted person's agreement (rule 21); removing one is a content edit.
- Retention policies seeded into `retention_policies` by the site seed (`on conflict (key) do nothing`), enforced by `privacy.retention_sweep`: `site_cookie_consents` table `cookie_consents`, 395 days, `delete`; `site_terms_acceptances` table `terms_acceptances`, 2,555 days (7 years), `delete`; `site_page_edit_requests` table `page_edit_requests`, 730 days, `delete` (the FK from `page_versions` is `on delete set null`).
- The public website sets no cookie except `beam_consent` (necessary, 182 days) and platform's `NEXT_LOCALE` (necessary, locale choice) and, after analytics consent, GA's `_ga` and `_ga_<id>` (analytics, 13 months); from R3, after marketing consent, `beam_ref` (30 days) and the Google Ads and Meta cookies `_gcl_au` and `_fbp` (marketing, 90 days). The portal adds Auth.js session cookies (necessary). Vercel Analytics sets no cookie but still waits for consent. The cookie notice page lists exactly these; a test asserts the list matches `COOKIE_INVENTORY` in `packages/core/src/site/consent.ts`.
- Claude in V1 (`site.propose_page`) receives page content and the staff instruction only, never personal data, so the subprocessor register's entry for Claude as a processor of personal data stays at Release 4 (proposal section 9); the `AI_FEATURES` entry for `site.propose_page` records `allowedFields: []`.

## 10. Dependencies

Needs from other modules (`modules/<m>/api.ts` unless a table is named). The names below are the owners' published names; the rows marked "request" do not exist yet in the owner's spec and are part of the review hand-off, so the owner adds them before the site package that needs them (site-P9 for commerce R3, P1's dependency-requests for platform). Until then the site package mocks them with `vi.mock` and keeps the call behind the `Result<T>` card guard.

| Module | Capability | Used for |
| --- | --- | --- |
| platform | `action()`, `defineJob`, `defineEvent`, `requirePermission`, `requireStaff`, `requireCustomer`, `ctx.audit`, `ctx.enqueue`, `ctx.recordEvent` (Wave 0 `lib/`) | every action and job |
| platform | `storeFile(ctx, { kind: 'image'\|'import', name, mime, bytes, isPublic })`, `readFile(tx, fileId)`, route `/api/public/files/[id]` with long-lived cache headers for public images | media library, WXR upload |
| platform | `getSetting(tx, key)` for `site` and `company`; settings key `site` declared in `M/config.ts` and edited through `updateSetting` | site settings, legal name, company footer |
| platform | `callClaude(ctx, { feature, model: 'opus'\|'haiku', system, messages, fieldsSent, outputSchema, maxTokens })`, `PermanentError('budget')`; `AI_FEATURES` entries `site.propose_page` (V1) and `site.audit_content` (R4, request) | Claude-assisted editing, R4 audit |
| platform | `PortalShell` (`packages/ui`) and `requireCustomer()`; the first `account/layout.tsx` written by platform-P6, which site-P6 takes over; nav registry from `nav.ts` (`audience: 'admin' \| 'customer'`) | portal layout, terms banner and analytics on every portal page |
| platform | `next.config.ts` already wraps the app with Serwist (`swSrc: 'app/sw.ts'`, disabled until the file exists); PL-67 CSP with nonce (`x-nonce` header) and `'strict-dynamic'`, GA4 and Vercel hosts already listed, Meta added in R3 | PWA, analytics |
| platform (request) | R3 CSP hosts for Google Ads (`https://www.googleadservices.com https://googleads.g.doubleclick.net` in `img-src` and `connect-src`, `https://www.facebook.com` in `connect-src`); `integration_calls_provider` value `wordpress` | R3 tags, WordPress client logging; filed by P1 in `docs/build/dependency-requests.md` |
| crm | `getPerson(db, personId)` (first name for the greeting), `resolvePersonIds(db, personId)`; crm reads `getCurrentLegalVersion(db, 'guardian_consent')` for its `person_declarations` | account home, terms reads, export and erase |
| crm | table `persons` (FK), table `companies` (FK, R3); portal page `/[locale]/account/profile` | acceptances, consents, partner pages, home link |
| booking | `listPublicEvents(db, { from, limit, offset })` (with `availabilityBand`), `getAvailabilityPreview(db, { kind, from, to })` (bands), `getAvailability(db, { sessionId })`, `getOpeningHours(db, { from, to })`, `describeAvailability` (core); table `sessions` (view, FK); settings `business_hours`; portal routes `/account/book`, `/account/book/[sessionId]`, `/account/bookings`, `/account/waitlist` | events listing and detail, availability, opening hours, entry points |
| booking | `listUpcomingBookingsForPerson(db, personId, limit): Promise<PersonBookingRow[]>`, `listOpenOffersForPerson(db, personId): Promise<{ entryId, sessionId, title: LocalizedText, startsAt, offerExpiresAt }[]>` (single person id: bookings and waitlist entries are mutable rows that crm's merge moves to the winner) | account home cards |
| booking (R2) | table `ticket_types` (read) and the lead-phase fields of `getAvailability` (`phase`, `opensAt`) | ticket prices and lead-magnet messaging on event pages |
| commerce | `getProductPrice(db, productId, audience: 'public'\|'member', at?)`; table `products` (read); site routes `/[locale]/checkout?sku=` and `/[locale]/gift`, portal `/account/shop`; commerce calls `site.getCurrentLegalVersion(db, 'terms')` and `site.recordTermsAcceptance()` at checkout | pricing tables, event prices, entry points, terms acceptance |
| credits | `getPersonCreditSummary(db, personId): { byKind: { kind, remainingUnits, nextExpiresAt }[]; membership; status; derivedStatus }` (an object, not an array), `getMembershipSummary(db, personId)` | account home balances and membership card |
| forms | `FormEmbed` server component with props `{ slug, locale, context: { pagePath, utm?, landingPath?, referrer?, partnerCompanyId? } }` (forms signs `context` into `embedContext`; site only passes it), `getPublishedFormMeta(db, slug)` (publish check, rule 6), `listPublishedForms(db)` (editor picker); seeded forms `contact` (kind lead) and `newsletter` (kind lead, consent purpose `newsletter`); the browser event `beam-form:completed` on success (R3 conversion tags) | contact page, footer newsletter, embedded forms, publish checks |
| forms (R3) | `countLandingConversions(db, { from, to }): Promise<{ landingPath, utmCampaign, submissions, newPersons }[]>` | insights |
| commerce (R3, request) | `countOrdersByLanding(db, { from, to }): Promise<{ landingPath, utmCampaign, orders, revenueCents }[]>` from `checkouts.utm` | insights |
| credits (R3) | `resolveReferralCode(db, code)` is called by crm at person creation with the code from `site.readReferralCode()`; site only stores the code | referral cookie |
| finance | portal route `/account/invoices` | quick action link only |
| webinar (R2) | `WebinarSignup({ webinarId, locale })` server component, `listPublicWebinars(db, { locale, from, limit })`, `getWebinarForSession(db, sessionId)`, `listUpcomingRegistrationsForPerson(db, personId)`; public pages `/[locale]/webinars/[slug]` | `webinar_signup` block, event pages linked to a webinar, account home card |
| ops | table `retention_policies` (seed rows), `privacy.retention_sweep` (deletes rows of the APPEND tables `cookie_consents` and `terms_acceptances` under `SET LOCAL beam.allow_rewrite = 'on'`), `GDPR_REGISTRY` consumption with `site` in `ERASE_ORDER` between `finance` and `ops` | retention and privacy |

Provides to other modules:
- commerce, crm, booking: `getCurrentLegalVersion`, `recordTermsAcceptance`, `hasAcceptedCurrentTerms` (checkout including membership conditions, first booking, sign-up, POS); crm: `getCurrentLegalVersion(db, 'guardian_consent')` for declarations.
- email: `getLegalLinks(locale)` for the legal footer; `getPageUrl` and `getEventPageUrl` for links in templates.
- automation and email templates: `getEventPageUrl`, `portalUrl`.
- platform: the portal layout from Wave 1 (`PortalShell` plus `PortalSiteChrome`), the accessibility statement (PL-90) and privacy notice links for its sign-in screens through `getLegalLinks()`; every module with portal pages: the layout and portal home that links to them, the terms banner, and the PWA service worker.
- forms, booking, credits: the stable event link `/<prefix>/events/<sessionId>` (rule 57) for CTAs and emails.
- forms: the public pages that host their embeds and pass `context` (page path, landing path, UTM, referrer, R3 partner); the R3 referral code reaches forms through the `beam_ref` cookie that crm reads at person creation, not through `context`.
- crm, commerce, platform sign-up, forms (R3): `readReferralCode()` (rule 63).
- ops: `site.terms_accepted` timeline events; privacy registration.

## 11. Edge cases and failure modes

1. Two staff members edit the same page: the second save returns `conflict` (rule 15); the editor shows "Someone else saved this page" with a reload button that keeps the unsaved text in a side panel for copying.
2. Two publishes of the same page at once: both lock the page row; the second sees the version already `published` and returns `conflict` "already published".
3. A path in a new version is already live for another page in that locale: publish fails with issue `path_taken` naming the other page.
4. A redirect exists from a path that a page now claims: the publish transaction deletes the redirect (rule 11) and audits it in the same `site.page.publish` row.
5. Redirect to a page that is later archived with no redirect of its own: the redirect answers 410; the content issues panel lists the redirect.
6. Manual redirect from a live page path: `upsertRedirect` refuses with `conflict` "a live page uses this path".
7. Claude returns invalid JSON or unknown block types: one repair round, then `invalid_output`; nothing is written to `page_versions`.
8. Claude removes a locale or changes the page kind: the validator rejects the output (rule 44) and counts it as invalid output.
9. Claude writes "€ 35" in text although prices come from the catalogue: allowed but flagged with warning `currency_in_text` on the diff.
10. The AI budget is exhausted: `requestProposal` still creates the request; the job fails at once with `budget_exceeded`; the panel says "AI budget reached for this month, edit manually".
11. The base draft is edited while Claude works: the proposal diffs against the base it was given; the review screen shows "The draft changed after this proposal was made" and publishing the proposal does not touch the draft, which becomes "out of date" (rule 16).
12. A scheduled publish whose form was archived in the meantime: the job fails the checks, clears the schedule, writes `site.page.schedule_failed`, and the page shows the issue; the live version stays.
13. A product in a pricing table is deactivated after publish: the rendered table omits it within 5 minutes; if no product is left the block renders nothing; `/admin/site` lists the issue.
14. An event session linked to a page is cancelled: the listing drops it; the detail page shows "This event was cancelled" with `noindex`; the sitemap drops it.
15. An event session is deleted by booking: `pages.session_id` becomes null (FK set null); the page keeps rendering its blocks without event facts and is flagged `event_session_missing`.
16. A visitor opens `/fr/<path>` that exists only in `nl-BE`: no `fr-BE` route exists, so the resolver checks other locales' routes for the same path and, when found, sends the visitor to `/fr/unavailable?page=<id>`; otherwise 404.
17. A WordPress URL `/over-ons/` arrives: `proxy.ts` redirects it to `/nl/over-ons`; the resolver finds no route, then looks up `redirects` for `/nl/over-ons` and then for the prefix-less `/over-ons`, and redirects to the imported page.
18. A WordPress `?p=123` or `?page_id=45` link: the home route reads `p` or `page_id` from `searchParams` and looks up `/?p=123` in `redirects` before rendering home.
19. WXR file with shortcodes, Gutenberg comments and inline styles: shortcodes are stripped and listed in the report, comments ignored, styles dropped; `img` becomes an `image` block, YouTube iframes become `video` blocks, other iframes are dropped and reported.
20. WXR file larger than 10 MB or not valid XML: the upload is refused (`validation`), or the parse job marks the import `failed` with the parser's line number.
21. An attachment URL on the old site is already gone: the item is `error` "media missing"; the page imports without the image and the report lists it.
22. Cookie banner script blocked by an ad blocker: no consent cookie, no analytics, the banner shows again next visit; necessary functions keep working.
23. Visitor rejects analytics, then accepts in the settings dialog: a second `cookie_consents` row is written with the same `consent_key`; analytics loads without a reload.
24. Customer with a stale cached account page offline: the service worker serves the offline page for navigations when the network fails; it never shows cached personal data from another session (account HTML is not cached).
25. A module's API used by account home throws (for example credits): that card shows "Temporarily unavailable", the error goes to Sentry, the rest of the page renders.
26. A customer switches the locale in the portal header: platform's locale switch changes the URL prefix only; the preferred language for emails changes in crm's profile page. The site home renders in the URL locale.
27. Publishing new material terms while a customer is mid-checkout: commerce records acceptance of the version shown at checkout start; the portal banner then asks for the newer version.
28. No published terms: `getCurrentLegalVersion(db, 'terms')` returns null and `/admin/site` shows the red go-live banner; commerce's checkout refuses with `terms_unavailable` in every environment (commerce rule 26a), which is why the site seed publishes a demo `terms` version in `beam_dev`, previews and seeded test databases (section 8).
29. Huge page (60 blocks per locale, several FAQs): the 60-block cap keeps documents under 300 KB; `saveDraft` refuses a body over 1 MB with `validation`.
30. Staging or preview deployment indexed by search engines: `robots.txt` disallows everything outside production and every non-production page renders `<meta name="robots" content="noindex, nofollow">` from `buildPageMetadata` (`next.config.ts` is frozen, so no header rule is added).
31. Two persons are merged after both accepted terms: the acceptances stay on their original person ids (append-only); `hasAcceptedCurrentTerms(winner)` reads both through `crm.resolvePersonIds`, so the winner sees no banner when either had accepted the current version.
32. A customer double-clicks "Accept" on the terms banner: both calls share the idempotency key `terms:<person>:<version>:portal_prompt:none`; one row, one event, both return `ok`.
33. New material terms are published while the banner is open: `acceptCurrentTerms` with the old `versionId` returns `conflict` "newer terms published, reload"; nothing is written.
34. A stable link `/<prefix>/events/<sessionId>` for a session without an event page: 307 to `/<prefix>/account/book/<sessionId>`; for a cancelled session the booking page shows its own cancelled state.
35. A holiday is added for tomorrow: within 5 minutes the contact block lists "Closed: <name>" and the JSON-LD carries the special opening hours; sessions are handled by booking.
36. An event session linked to a webinar (R2): `getWebinarForSession()` returns the webinar, so the event page shows "Register for the webinar" linking to `/<prefix>/webinars/<slug>` instead of a booking button.
37. A visitor arrives with `?ref=ABCD2345` and rejects marketing cookies (R3): no `beam_ref` cookie; the code rides only on the links of that page view (rule 63); if they navigate away it is lost, by design.
38. A page with a pending Claude request is archived: the request becomes `cancelled`; a request already `running` finishes with `failed` / `page_archived` and inserts no version.
39. The accessibility statement or the company details are missing in production: red go-live banner on `/admin/site` and a failing item in the go-live runbook; the public site still renders.
40. A WordPress import is retried after network errors fetched only part of the media: `retryImportErrors` re-runs only `error` items in a new apply round; already imported items and fetched media are skipped (`media_assets.wordpress_url` unique).
41. A guardian consent is recorded at reception while no `guardian_consent` page is published: `getCurrentLegalVersion(db, 'guardian_consent')` returns null, crm's `recordDeclaration` answers `validation`, and `/admin/site` lists the missing legal page as a go-live issue (rule 67).

## 12. Build packages

Order and tracks: P1 first. Then three tracks may run in parallel because they share no file: track A P2 -> P5 -> P6, track B P3 -> P4 -> P7, and nothing else in V1. R2-R4 packages (P8, P9, P10) run after all V1 packages are merged, in that order. Paths below are relative to the repo root; `M` = `apps/web/modules/site`. Every package's done-definition includes: `pnpm gen:indexes && pnpm typecheck && pnpm lint` green, its listed Vitest suites green on `createTestDb()` (PGlite, from schema), `pnpm i18n:check` green, no edits to `package.json`, the lockfile, `packages/db/migrations/`, `registry/*.generated.ts` or frozen files.

### site-P1 (V1): schema, core content model, module skeleton

- Goal: every site table, enum and view; the pure block, path, completeness, diff, consent, availability-band, company and JSON-LD logic; the module file skeleton with barrels and stubs so later packages each own separate files; the complete V1 `site` catalogue.
- Files: `packages/db/src/schema/site.ts` (complete the Wave 0 stub, keep existing `pages`/`page_versions` columns; creates every table and column of section 2 including the R3 column `pages.partner_company_id` and the R4 table `site_audit_reports`, both unused until their release, so R2-R4 need no site migration), `packages/db/src/schema/site.views.ts`, `packages/db/src/schema/site.test.ts`; `packages/core/src/site/{index,types,locales,links,rich-text,blocks,paths,completeness,diff,warnings,jsonld,consent,image-size,availability,company,settings,proposal}.ts` (`index.ts` and `types.ts` exist from Wave 0 and are edited) with `*.test.ts` beside `blocks`, `paths`, `completeness`, `diff`, `warnings`, `jsonld`, `consent`, `image-size`, `availability`, `company`; `packages/core/src/i18n/messages/{en,nl-BE,fr-BE}/site.json`; `M/{actions,queries,jobs,api}.ts` (Wave 0 files turned into barrels), stubs `M/actions/{pages,nav,redirects,media,proposals,wordpress,portal,partner}.ts`, `M/queries/{public,admin,proposals,portal,wordpress,insights}.ts`, `M/jobs/{publish,propose,wordpress,audit}.ts`, `M/server/{legal,urls,settings,referral}.ts` (exported api functions throwing `NotImplementedError`; `readReferralCode` returns `null` until R3), `M/ui/portal/site-chrome.tsx` (stub `PortalSiteChrome` returning `null`, internal to the module); `M/{permissions,events,nav,schedules,privacy,config}.ts` (Wave 0 files, edited), `M/privacy.test.ts`; append to `docs/build/dependency-requests.md`.
- Interfaces: all core types and functions of section 4 ("Core types"), `ProposalOutput = z.object({ title, paths, blocks: BlocksByLocale, seo, excerpt: LocalizedText.optional(), changeSummary: z.string().max(500) })`, `SiteSettings` Zod with defaults, `COOKIE_INVENTORY`, the api.ts signatures of section 4, `sitePrivacy`.
- Orchestrator requests written to `docs/build/dependency-requests.md`: add `terms_acceptances`, `cookie_consents` and `site_audit_reports` to `APPEND_ONLY_TABLES` and their triggers to a custom migration; npm packages if absent from Wave 0: `@tiptap/react`, `@tiptap/starter-kit`, `@tiptap/extension-link`, `fast-xml-parser`, `node-html-parser`, `@axe-core/playwright` (no `@vercel/analytics`: the loader uses `next/script`); the platform frozen-file items of section 10 (R3 Google Ads CSP hosts, `wordpress` provider value, `AI_FEATURES` key `site.audit_content` for R4). The Serwist wrapper and the GA4 and Vercel CSP hosts already exist in Wave 0 and are not requested.
- Depends on: Wave 0 (`_shared.ts` helpers, stub tables `pages`, `sessions`, `files`, `users`, `persons`, `companies`).
- Tests: `site.test.ts` (tables and views create on PGlite; one-draft partial unique; singleton home; legal key unique incl. `accessibility_statement` and `guardian_consent`; route uniqueness per locale; redirect target check; a `superseded` user row is refused; acceptances idempotency key unique); `blocks.test.ts` (every block type valid and invalid samples, `javascript:` href rejected, hero only first, testimonial without consent rejected, video without `posterMediaId` rejected, 60-block cap); `paths.test.ts` (normalisation incl. trailing slash, case, `?p=`, every reserved segment of rule 9, `events/<uuid>` reserved and parsed, legacy-gone prefixes, 3-segment cap); `completeness.test.ts` (each issue code, per locale, legal-name check, alt text, excerpt for posts); `availability.test.ts` (bands at 0, 1, 4, 5 seats and at 9 % and 10 % of capacity); `company.test.ts` (enterprise number from `BE0123456789` and from malformed input); `diff.test.ts` (block pairing by id, inserted, deleted, moved, word diff); `warnings.test.ts` (currency in text, removed blocks, path change); `jsonld.test.ts` (HealthAndBeautyBusiness with opening hours and special hours, Event, BlogPosting, FAQPage, `<` escaped); `consent.test.ts` (encode/decode, expiry 182 days, re-prompt on material version); `image-size.test.ts` (PNG, JPEG, WebP, GIF fixtures as byte arrays; SVG and AVIF return null); `privacy.test.ts` (export lists rows of the person and of a merged-away person id; erase deletes consents, anonymises acceptances; no row keeps the IP).
- Done: common definition.

### site-P2 (V1): public rendering, routing, redirects, metadata

- Goal: every public page renders from the database with all V1 block types, header and footer menus with company identification, locale switch, redirects, stable event links, legacy-gone paths, 404/410, unavailable page, staff preview, RSS, opening hours with closures, per-page metadata with hreflang and JSON-LD.
- Files: `apps/web/app/[locale]/(site)/{layout.tsx, error.tsx, not-found.tsx, [[...path]]/page.tsx, unavailable/page.tsx, preview/[versionId]/page.tsx, feed.xml/route.ts}` (deletes a Wave 0 `(site)/page.tsx` placeholder if one exists); `M/server/{resolve,render-data,urls,metadata}.ts` (+ `resolve.test.ts`, `urls.test.ts`, `metadata.test.ts`); `M/queries/public.ts`; `M/ui/public/{site-header,site-footer,company-footer,mobile-menu,locale-switcher,page-view,block-renderer,rich-text,media-image,json-ld,preview-ribbon}.tsx`; `M/ui/public/blocks/{hero,rich-text,image,image-text,cta,card-grid,faq,pricing-table,events-list,availability-preview,posts-list,form-embed,booking-cta,video,testimonial,contact-details,map,legal-meta}.tsx`; `M/ui/public/block-renderer.test.tsx`; `apps/web/e2e/site-public.spec.ts`.
- Interfaces: `resolveRequest(locale, segments, searchParams)`, `getPageByPath`, `getNavMenus`, `listPublicEventsForSite`, `listPosts`, `getPricingRows`, `getOpeningHours`, `getCompanyFooter`, `buildPageMetadata(page, locale): Metadata`; implements `getPageUrl`, `getEventPageUrl`, `portalUrl` in `M/server/urls.ts`.
- Depends on: site-P1; `booking:listPublicEvents`, `booking:getAvailabilityPreview`, `booking:getAvailability`, `booking:getOpeningHours`, `commerce:getProductPrice`, `forms:FormEmbed`, `platform:getSetting` (`company`, `business_hours`, `site`), `platform:/api/public/files/[id]`. Tests mock the cross-module api functions with `vi.mock`.
- Tests: `resolve.test.ts` (live route; rename redirect to current path; `to_url` redirect; prefix-less legacy lookup; `?p=` lookup on home; archived 410; unpublished 404; other-locale path -> unavailable; `events/<uuid>` to the event page, to the portal booking page without one, 404 for a non-event id; `/nl/wp-admin` 410; redirect seen counter updated through `after()`); `urls.test.ts` (absolute URLs from `canonicalOrigin`, portal routes, event page fallback to booking URL); `metadata.test.ts` (canonical, hreflang only for live locales, x-default, noindex for past events after 30 days and for non-production); `block-renderer.test.tsx` (one h1 rule, rich text renders no raw HTML, video facade has no iframe and no Google URL before click, testimonial, pricing shows member line from the member price and from `member_discount_pct`, availability bands without numbers (preview block renders `getAvailabilityPreview` bands), events list empty state and `listPublicEvents` paging, `form_embed` renders `FormEmbed` with `context.pagePath` and UTM, `buy_product` links to `/<prefix>/checkout?sku=`, `gift` links to `/<prefix>/gift`, contact block lists a holiday of the next 30 days from a mocked `getOpeningHours` and hides hours when `business_hours` is empty, footer shows legal name, address, enterprise number and VAT).
- e2e `site-public.spec.ts`: home in three locales, `lang` attribute, nav to an offer page, locale switch, pricing table shows seeded prices, events list to event detail to "Get tickets" lands on portal sign-in with `callbackUrl`, "Buy" opens commerce's guest checkout, legacy WordPress path redirects, 404 and 410 statuses; Wave 2's `e2e/acceptance-v1.spec.ts` ("customer can register, book, pay") starts from the public pages this package delivers.
- Done: common definition plus the e2e spec green against `beam_dev`.

### site-P3 (V1): back-office CMS, publishing, navigation, media, redirects, settings

- Goal: staff create, edit, preview, publish, schedule, unpublish, archive and restore pages; edit menus, media and redirects; read-only site settings summary; content issues dashboard with the go-live banner.
- Files: `M/actions/{pages,nav,redirects,media}.ts` (+ `pages.test.ts`, `nav.test.ts`, `redirects.test.ts`, `media.test.ts`); `M/server/{versions,publish,refs,cache}.ts` (+ `versions.test.ts`, `publish.test.ts`); implements `M/server/settings.ts`; `M/jobs/publish.ts` (+ `publish.test.ts` in `M/jobs/`); `M/queries/admin.ts`; `M/permissions.test.ts`; `apps/web/app/(admin)/admin/site/{page.tsx, loading.tsx, error.tsx, pages/new/page.tsx, pages/[pageId]/page.tsx, navigation/page.tsx, media/page.tsx, redirects/page.tsx, settings/page.tsx}`; `M/ui/admin/{pages-table,content-issues,page-editor,block-list-editor,block-forms,rich-text-editor,pickers,seo-fields,version-history,nav-editor,media-library,redirects-table,settings-summary}.tsx`; `apps/web/e2e/site-admin.spec.ts`.
- Interfaces: `publishVersionTx(tx: Tx, ctx: Ctx, versionId: string, opts: { scheduledBy?: string }): Promise<{ publishedAt: Date }>` (used by the action, the job and P7), `allocateVersion(tx, pageId): Promise<number>`, `assertMutable(row)`, `loadRefFacts(db, refs): Promise<RefFacts>`, `revalidateSite(tags: string[])` (calls `revalidateTag(tag, 'max')`), `getSiteSettings`, `getContentIssues()` (all issue codes of `/admin/site`, including the go-live ones of rules 59-61).
- Depends on: site-P1; `platform:storeFile`, `platform:getSetting`, `forms:getPublishedFormMeta` (publish check), `forms:listPublishedForms` (picker), `commerce:getProductPrice`, `booking` table `sessions`, `webinar:listPublicWebinars` (R2 references only; mocked in V1 tests).
- Tests: `pages.test.ts` (create; save with conflict; one draft; publish blocked with issues per locale; publish writes routes and audit; rename creates redirect and removes a clashing one; schedule bounds; unpublish 404 semantics; archive with redirect, archive rejects open proposals and cancels pending requests; `restoreArchivedPage` back to draft and its `conflict` when the singleton kind or legal key is taken; every allowed transition of rules 54-55 and one refused transition per state; restore version copies; published row cannot be updated; go-live issues for missing accessibility statement and company details); `nav.test.ts` (completeness, version conflict, hidden targets reported); `redirects.test.ts` (normalisation, live-path conflict, loop refusal); `media.test.ts` (mime and size refusal, SVG refused, dimensions stored, delete refused when referenced); `jobs/publish.test.ts` (publishes at run time; failed checks clear schedule and audit; double run yields one publish); `permissions.test.ts` (each P3 action refused without `site.edit`/`site.publish`).
- e2e `site-admin.spec.ts`: marketing user logs in with TOTP, creates an offer page in three locales, sees completeness issues, uploads an image with alt text, publishes, opens it on the public site, renames the path and the old path redirects.
- Done: common definition plus e2e green.

### site-P4 (V1): Claude-assisted editing and side-by-side review

- Goal: staff describe a change; `site.propose_page` writes a `proposed` version created by Claude; a reviewer sees the diff and publishes, rejects or copies it into the draft.
- Files: `M/actions/proposals.ts` (+ `proposals.test.ts`), `M/jobs/propose.ts` (+ `propose.test.ts`), `M/server/{ai-prompt,proposal-validate}.ts` (+ `ai-prompt.test.ts`), `M/queries/proposals.ts`, `apps/web/app/(admin)/admin/site/pages/[pageId]/versions/[versionId]/page.tsx`, `M/ui/admin/{claude-panel,version-diff,diff-text,preview-frames}.tsx`; edits `M/ui/admin/page-editor.tsx` to mount the Claude panel (strictly after site-P3, which created it); `apps/web/e2e/site-claude.spec.ts`.
- Interfaces: `buildProposalPrompt(input: { page, base, instruction, locales, refs, brandVoice }): { system: string; messages: AiMessage[]; fieldsSent: string[] }`, `validateProposal(base, output, page): { ok: true; content } | { ok: false; errors: string[] }`.
- Depends on: site-P3 (`allocateVersion`, `publishVersionTx`, editor); `platform:callClaude` and `anthropic/fake.ts`.
- Tests: `propose.test.ts` (fake returns valid output -> proposed version with `created_by = 'claude'`, `edit_request_id`, `based_on_version_id`; invalid then valid -> one repair; invalid twice -> `failed`/`invalid_output`, no version; `PermanentError('budget')` -> `budget_exceeded`; retryable error then success; last attempt failing -> `ai_unavailable`; archived page -> `page_archived` and no version; double run -> one version; kind change or dropped locale rejected); `proposals.test.ts` (requires `ai.use`; one active request per page; cancel only pending; reject sets reason; copy to draft respects `replaceExisting` and sets the proposal `superseded`; publishing a proposal requires `site.publish`); `ai-prompt.test.ts` (no email, phone or person names from the database in the prompt; `fieldsSent` exact; reference lists capped at 200 items).
- e2e `site-claude.spec.ts` (fake Claude): ask for an FAQ, wait for proposal, see inserted block highlighted in the diff, publish, public page shows the FAQ.
- Done: common definition plus e2e green.

### site-P5 (V1): SEO files, cookie consent and analytics, legal and terms, PWA

- Goal: sitemap, robots, manifest, icons, service worker and offline page; cookie banner with logged choices and consent-gated Vercel Analytics and GA4; legal API (current versions, terms acceptance) for other modules; the accessibility and performance gates.
- Files: `apps/web/app/{sitemap.ts, robots.ts, manifest.ts, sw.ts}`, `apps/web/app/pwa-icon/[size]/route.tsx`, `apps/web/app/[locale]/(site)/offline/page.tsx`, `apps/web/app/api/public/cookie-consent/route.ts` (+ `route.test.ts`); implements `M/server/legal.ts` (+ `legal.test.ts`); `M/server/{sitemap,consent}.ts` (+ `sitemap.test.ts`); `M/ui/public/{consent-provider,cookie-banner,cookie-settings-dialog,analytics-loader,utm-capture,sw-register}.tsx`; edits `apps/web/app/[locale]/(site)/layout.tsx` to mount them (strictly after site-P2, which created it); `apps/web/e2e/{site-consent,site-a11y,site-perf}.spec.ts`.
- Interfaces: `getCurrentLegalVersion`, `recordTermsAcceptance`, `hasAcceptedCurrentTerms`, `getLegalLinks` (section 4), `recordCookieConsent(db, input): Promise<{ consentKey }>`, `getSitemapEntries(): Promise<MetadataRoute.Sitemap>`, `<ConsentProvider>` with `useConsent(): { analytics: boolean; marketing: boolean; open(): void }`.
- Depends on: site-P2 (layout, urls); `platform:recordEvent` for `site.terms_accepted`; `crm:resolvePersonIds`; platform's PL-67 CSP and `x-nonce` header (Wave 0).
- Tests: `legal.test.ts` (null when unpublished; `version` is the ordinal from `v_legal_versions`, `requiresReacceptance` mirrors `is_material_change`, `text` is plain text per live locale; `guardian_consent` resolves like `terms`; acceptance idempotent; event written once; material change makes `hasAcceptedCurrentTerms` false; non-material keeps it true; an acceptance on a merged-away person id counts for the winner; `getLegalLinks` includes the accessibility statement); `sitemap.test.ts` (live routes with alternates, excludes noindex, archived, past events after 30 days; robots per environment); `route.test.ts` (valid body inserts row and sets cookie attributes; person linked when a customer session exists; invalid body 400; ip stored only as HMAC).
- e2e `site-consent.spec.ts`: no request to `googletagmanager.com` or `/_vercel/insights/*` before consent; reject-all keeps it so; accept loads both (production-mode flag set in the test env) with the page's nonce on each `<script>` and no CSP violation reported; withdraw from footer removes `_ga` cookies; banner buttons have equal size. `site-a11y.spec.ts`: axe (`wcag2a`, `wcag2aa`, `wcag21aa`) with zero serious or critical violations on home, offer, pricing, events, event detail, contact, legal, 404; keyboard-only path through menu and banner. `site-perf.spec.ts`: on home, offer and event detail with Chromium CPU throttling 4x and the "Fast 4G" network profile through CDP, LCP <= 2.5 s and CLS <= 0.1 from `PerformanceObserver`, and the sum of transferred first-load JavaScript (gzip) <= 120 KB; field p75 values are read from Vercel Analytics after go-live.
- Done: common definition plus both e2e specs green; manifest passes Chrome installability (checked in e2e via `page.evaluate` of the manifest and service-worker registration).

### site-P6 (V1): portal home and portal chrome

- Goal: the portal layout (taken over from platform-P6), the portal home `/[locale]/account` and `PortalSiteChrome` (terms banner, consent-gated analytics, cookie-settings link), plus the install prompt.
- Files: edits (takes over) `apps/web/app/[locale]/(portal)/account/layout.tsx` (keeps platform-P6's `requireCustomer()` and `PortalShell`, adds `PortalSiteChrome` and passes the `x-nonce` value to it), creates `apps/web/app/[locale]/(portal)/account/page.tsx` (platform keeps the sibling `loading.tsx`, `error.tsx` and `security/`); `M/actions/portal.ts` (+ `portal.test.ts`), `M/queries/portal.ts` (+ `portal.test.ts` in `M/queries/`); implements `M/ui/portal/site-chrome.tsx` (P1 stub); `M/ui/portal/{account-home,terms-banner,install-prompt}.tsx`, `M/ui/portal/cards/{bookings-card,balance-card,membership-card,offers-card,quick-actions}.tsx`; `apps/web/e2e/site-portal.spec.ts`.
- Interfaces: `getAccountHome(personId, locale): Promise<{ firstName; bookings: Result<PersonBookingRow[]>; balances: Result<PersonCreditSummary['byKind']>; membership: Result<MembershipSummary | null>; offers: Result<WaitlistOffer[]> }>` (from `booking.listUpcomingBookingsForPerson(db, personId, 5)`, `credits.getPersonCreditSummary(db, personId).byKind`, `credits.getMembershipSummary(db, personId)`, `booking.listOpenOffersForPerson(db, personId)`) where `Result<T> = { ok: true; data: T } | { ok: false }` (one failing module never fails the page), `getTermsBannerState(personId)`, `acceptCurrentTerms`, `PortalSiteChrome`.
- Depends on: site-P5 (`hasAcceptedCurrentTerms`, `recordTermsAcceptance`, consent components, `sw-register`); `crm:getPerson`, `crm:resolvePersonIds`, `booking:listUpcomingBookingsForPerson`, `booking:listOpenOffersForPerson`, `credits:getPersonCreditSummary`, `credits:getMembershipSummary`, `platform:PortalShell`, `platform:requireCustomer` and platform-P6's first `account/layout.tsx`.
- Tests: `queries/portal.test.ts` (only the actor's data and merged-away ids; guest bookings made by the person included; at most 5 bookings; a throwing credits api yields `{ ok: false }` for that card only); `actions/portal.test.ts` (accept terms writes one acceptance with context `portal_prompt`; second call is a no-op; an old `versionId` returns `conflict`; staff and anonymous refused); `site-chrome` render test in `portal.test.ts` (banner shown only after a material terms version; no analytics script without consent; the layout renders `PortalShell` and the chrome and redirects an anonymous visitor to sign-in).
- e2e `site-portal.spec.ts`: customer signs in by magic link (email sink), sees account home with a seeded booking and balance, follows Book a day session, opens My details (crm page), sees and accepts the terms banner on another portal page after a material terms publish; axe zero serious or critical violations on account home.
- Done: common definition plus e2e green.

### site-P7 (V1): WordPress migration and seed content

- Goal: upload a WXR export, map items to pages and posts with locales and translation groups, fetch media, create draft pages and redirects from every old URL, retry failed items, publish complete imported pages in bulk; development seed content; the go-live runbook (rehearsal, DNS switch, monitor).
- Files: `packages/integrations/src/wordpress/{client.ts, fake.ts, index.ts, client.test.ts}`; `M/server/wordpress/{wxr,convert,apply}.ts` (+ `wxr.test.ts`, `convert.test.ts`, `apply.test.ts`), `M/server/wordpress/__fixtures__/beam-sample.wxr.xml` (10 pages in nl and fr with WPML groups, 4 posts, 6 attachments, shortcodes, Gutenberg comments, one comment and one author that must not be stored); `M/actions/wordpress.ts`, `M/jobs/wordpress.ts` (+ `wordpress.test.ts` in `M/jobs/`), `M/queries/wordpress.ts`; `apps/web/app/(admin)/admin/site/imports/{page.tsx, [importId]/page.tsx}`; `M/ui/admin/{imports-table,import-mapping,redirect-coverage}.tsx`; `packages/db/src/seed/site.ts` (+ `site.test.ts`), `M/seed.ts`; `docs/runbooks/site-go-live.md` (week 7 rehearsal on `staging`; content freeze on WordPress; final WXR export; import, review, bulk publish; redirect coverage at 100 % of old paths with traffic; legal pages (terms with every chapter of rule 62, guardian consent), accessibility statement and company details present; Vercel domains `www.beam.be` primary and `beam.be` redirecting; DNS TTL lowered to 300 s 48 h before; switch the `www` CNAME and apex A record to Vercel in week 8; Better Stack monitor of section 6; Google Search Console sitemap resubmission; rollback = point DNS back to WordPress hosting, kept 30 days).
- Interfaces: `parseWxr(xml: string): { items: WxrItem[]; errors: { line: number; message: string }[] }`, `htmlToBlocks(html: string, ctx: { mediaByUrl: Map<string,string> }): { blocks: Block[]; report: ConvertReport }`, `applyImportChunk(tx, ctx, importId, offset, limit = 50): Promise<{ next: number | null }>`, actions `startWordpressImport`, `updateImportItem`, `applyWordpressImport`, `retryImportErrors`, `publishImportedPages`, `WordpressMediaClient` (section 6).
- Depends on: site-P3 (`allocateVersion`, `publishVersionTx`); `platform:storeFile` (P7 inserts `media_assets` itself and does not import `actions/media.ts`); the platform `wordpress` provider value (request); npm `fast-xml-parser`, `node-html-parser` (requested by P1).
- Tests: `wxr.test.ts` (fixture parse counts; authors and comments absent; translation groups; drafts default to skip; malformed XML reports a line); `convert.test.ts` (headings h1 -> h2, lists, links, bold and italic, `img` -> image block, YouTube iframe -> video, shortcodes stripped and reported, inline styles dropped, empty paragraphs removed); `apply.test.ts` (WPML group becomes one page with two locales; redirects for each old path and attachment URL; `/feed` redirect; `redirect_only` items; rerun creates nothing new; an item already imported by an earlier import is skipped; `retryImportErrors` re-runs only `error` items and moves the import through `applying` to `done`; a dead chunk sets `failed`); `jobs/wordpress.test.ts` (parse, media and apply jobs each run twice -> same state; 404 media marks the item error and continues); `client.test.ts` (refuses other origins, size cap, mime check, logs integration calls); `packages/db/src/seed/site.test.ts` (seeding twice yields one published version per seeded page; `getCurrentLegalVersion(db, 'terms')` and `'guardian_consent'` are non-null after seeding; production profile seeds nothing).
- e2e: none (covered by integration tests; the real import is a rehearsal in week 7 on `staging`).
- Done: common definition.

### site-P8 (R2): events and ticketing extensions, webinar cards, R2 portal cards

- Goal: event detail pages show ticket types with public and member prices, lead-magnet messaging with "Check your access" and sold-out waitlist entry; event pages linked to a webinar show "Register for the webinar"; the `webinar_signup` block renders a card linking to the webinar module's registration page; account home shows upcoming webinars and a "Shared with me" link to credits' packages page.
- Files: `M/ui/public/blocks/{events-list.tsx (edit), webinar-signup.tsx}` (`webinar-signup.tsx` only maps the block to webinar's `WebinarSignup({ webinarId, locale })` from `modules/webinar/api.ts`), `M/ui/public/event-facts.tsx`, `M/server/render-data.ts` (edit), `M/queries/public.ts` (edit), `M/queries/portal.ts` (edit), `M/ui/portal/account-home.tsx` (edit), `M/ui/portal/cards/webinars-card.tsx`, `M/ui/portal/cards/quick-actions.tsx` (edit), `packages/core/src/i18n/messages/*/site.json` (edit), tests `M/ui/public/event-facts.test.tsx`, `apps/web/e2e/site-events-r2.spec.ts`. Strictly after all V1 packages.
- Depends on: site-P2, site-P6; booking table `ticket_types` and the lead-phase fields of `booking:getAvailability`, `commerce:getProductPrice`, `webinar:WebinarSignup`, `webinar:listPublicWebinars`, `webinar:getWebinarForSession`, `webinar:listUpcomingRegistrationsForPerson` (card behind `ff_webinar_portal`).
- Tests: ticket prices per type with member line; lead window open shows "Priority access for new guests until <date, Europe/Brussels>" and a "Check your access" button to the portal session page, never a count, a rank or a direct booking button (scenario 3); full event shows waitlist entry; webinar-linked event shows the webinar button; `webinar_signup` block renders `WebinarSignup` with the block's `webinarId` and the page locale; webinar card scoped to the person and hidden when the flag is off.
- Done: common definition plus e2e green.

### site-P9 (R3): marketing tags, partner landing pages, referral capture, landing insights

- Goal: marketing consent activates Google Ads conversion and Meta Pixel; landing pages linked to a partner company pass the partner to forms; `?ref=` codes are kept in `beam_ref` (rule 63) and exposed through `readReferralCode`; insights screen per landing page and campaign.
- Files: `packages/core/src/site/settings.ts` (edit: ad ids), `packages/core/src/site/consent.ts` (edit: R3 entries of `COOKIE_INVENTORY`) and `consent.test.ts` (edit), `M/actions/partner.ts` (`setPagePartner`, `site.publish`, audit `site.page.set_partner`), `M/server/referral.ts` (implements `readReferralCode`) and `referral.test.ts`, `M/ui/public/referral-capture.tsx`, `M/ui/public/analytics-loader.tsx` and `cookie-settings-dialog.tsx` (edit), `apps/web/app/[locale]/(site)/layout.tsx` (edit: mount `referral-capture`), `M/ui/public/blocks/form-embed.tsx` (edit: `context.partnerCompanyId` for partner landing pages), `M/queries/insights.ts`, `apps/web/app/(admin)/admin/site/insights/page.tsx`, `M/ui/admin/page-editor.tsx` (edit: partner picker for landing pages), i18n `site.json` (edit), tests `M/actions/partner.test.ts`, `M/queries/insights.test.ts`, `apps/web/e2e/site-consent.spec.ts` (edit: marketing cases). Strictly after site-P8. No schema edit (the column exists since P1).
- Depends on: site-P5, site-P3; `crm` table `companies`; `forms:countLandingConversions`; `commerce:countOrdersByLanding` (request); `credits:resolveReferralCode` is called by crm, not here.
- Tests: no marketing tag and no `beam_ref` cookie without marketing consent; `beam_ref` keeps the first code for 30 days and ignores malformed codes; without consent the code appears only on that page view's portal, checkout and form links; partner id passed only for `landing` pages; insights totals match fixtures; permission `reports.read` required.
- Done: common definition plus e2e green.

### site-P10 (R4): Claude translations and weekly content audit

- Goal: "Translate missing locales" creates a `translate` edit request whose proposal fills the missing locales of a page; a weekly Claude audit writes `site_audit_reports` shown on `/admin/site`.
- Files: `M/actions/proposals.ts` (edit: `kind: 'translate'`), `M/jobs/propose.ts` and `M/server/ai-prompt.ts` (edit), `M/jobs/audit.ts`, `M/schedules.ts` (edit: `site.audit_content` `10 7 * * 1`), `M/ui/admin/{claude-panel,content-issues}.tsx` (edit), i18n `site.json` (edit), tests `M/jobs/audit.test.ts`, `M/jobs/propose.test.ts` (edit: translate cases). Strictly after site-P9.
- Depends on: site-P4; `platform:callClaude` with `model: 'haiku'` and the `AI_FEATURES` key `site.audit_content` (request).
- Tests: translation proposal keeps block ids and structure of the source locale and only adds target locales; audit double run inserts one report per week; findings never include personal data; budget exhaustion leaves no report and no failure loop.
- Done: common definition.

## 13. Decisions made

Additions to the architecture (tables, columns, settings, routes, providers):
1. Tables added beside the architecture's `pages` and `page_versions`: `page_routes`, `redirects`, `nav_menus`, `media_assets`, `page_edit_requests`, `terms_acceptances` (APPEND), `cookie_consents` (APPEND), `wordpress_imports`, `wordpress_import_items`, and `site_audit_reports` (APPEND, used from R4). Each answers a stated requirement: localised URLs, WordPress redirects, navigation, alt text (WCAG), Claude request tracking, terms versioning evidence, cookie consent evidence, migration.
2. Columns added to `pages`: `kind`, `legal_key`, `session_id`, `partner_company_id` (R3), `first_published_at`, `archived_at`, `archived_by_user_id`, `created_by_user_id`. Columns added to `page_versions`: `state`, `title`, `paths`, `excerpt`, `cover_media_id`, `is_material_change`, `change_summary`, `based_on_version_id`, `created_by_user_id`, `edit_request_id`, `scheduled_publish_at`, `published_by_user_id`, `rejected_at`, `rejected_by_user_id`, `reject_reason`, `updated_at`. `page_versions.seo` and `blocks` keep the architecture's "per locale" shape.
3. `page_versions` is IMMUTABLE only once published: a `draft` row is edited in place (one draft per page), a `proposed` row only changes state. This reads the architecture's IMMUTABLE rule literally ("a published version row is never edited").
4. `proposed_by_ai_request_id` has no foreign key, because `ai_requests` is purged after 30 days; the durable link is `edit_request_id`.
5. New `settings` key `site` (`SiteSettings`, section 4, snake_case values) declared in `M/config.ts`; it is edited only through platform's `updateSetting` (`settings.write`, PL-41) on `/admin/settings/site`, and `/admin/site/settings` is a read-only summary. Trade name and legal identity come from `settings.company`.
6. New public route `POST /api/public/cookie-consent` besides the architecture's `api/public/*` list; new metadata routes `sitemap.ts`, `robots.ts`, `manifest.ts`, `app/pwa-icon/[size]`; new site routes `preview/[versionId]`, `unavailable`, `offline`, `feed.xml`; the stable event link `events/<sessionId>` is served by the catch-all, not by a new folder.
7. New integration client `packages/integrations/src/wordpress/` (provider `wordpress` in `integration_calls`, added to platform's enum by an orchestrator frozen-file PR) used only during migration.
8. New job kinds, named `<module>.<verb_noun>`: `site.propose_page` (named in the architecture), `site.publish_version`, `site.parse_wordpress`, `site.fetch_wordpress_media`, `site.apply_wordpress`, and in R4 `site.audit_content` with schedule Monday 07:10. Idempotency keys follow `<noun>:<id>:<qualifier>`: `page_edit:<id>:propose`, `page_version:<id>:publish:<epoch>`, `wp_import:<id>:parse|media:<n>|apply:<offset>:<round>`, `terms:<person>:<version>:<context>:<ref>`. New activity event kind `site.terms_accepted`. No new permission strings.
9. `terms_acceptances`, `cookie_consents` and `site_audit_reports` must join `APPEND_ONLY_TABLES` and get the append-only trigger; `_shared.ts` and the custom migration belong to the orchestrator, so P1 files the request.

Content model and routing:
10. Blocks are stored per locale (architecture wording), with plain strings inside; staff get "copy blocks from nl-BE" to start a translation. Rich text is Tiptap-compatible JSON rendered by an in-house renderer; no HTML is stored or injected.
11. Eighteen V1 block types (section 4) plus `webinar_signup` (R2). No free HTML block and no third-party iframe except click-to-load YouTube nocookie.
12. Every public page goes through one optional catch-all route `app/[locale]/(site)/[[...path]]`; events index, blog index and event pages are page kinds with localised paths, not hard-coded folders.
13. Localised paths live in `page_versions.paths` and become live in `page_routes` on publish; renames create redirects that point to the page, so redirects never chain.
14. Redirects use 308 (`permanentRedirect`) for permanent and 307 for temporary; archived pages answer 410, unpublished 404.
15. An event page is a page of kind `event` linked to one booking session. Sessions without a page still appear in the listing and link straight to portal booking. Prices are never stored on the site.
16. Seats-left information is shown only as three bands (fewer than 5 seats or under 10 % = "Few places left"); no counts, no ranks.
17. Blog and news are pages of kind `post` (no separate posts table, no categories in V1), 12 per listing page, RSS of 20 items.
18. Canonical origin `https://www.beam.be` (editable in settings); `x-default` hreflang points to the nl-BE version.
19. Caching: public data through `unstable_cache` with tags (`site:page:<id>`, `site:routes`, `site:nav`, `site:sitemap`, `site:events`, `site:prices`, `site:hours`); page routes `revalidate = 3600`; prices and events at most 300 s old; publish revalidates with `revalidateTag(tag, 'max')`.
20. Scheduled publishing is a delayed job (`run_at`), not a per-minute schedule.
21. Publishing requires `site.publish`; there is no separate four-eyes rule, so the person who asked Claude may publish the proposal. The audit log records that the version came from Claude.

Claude-assisted editing:
22. Claude works only on page content plus reference lists (products, events, forms, pages) and the staff instruction; no personal data is sent; output is validated structured JSON with one repair attempt. Model `claude-opus-5-5`; the R4 audit uses `claude-haiku-5-5`.
23. One active Claude request per page; the panel polls every 2 s for up to 3 minutes; `after()` runs the job right after the request commits.
24. Prices written as text by Claude are allowed but flagged; pricing must come from `pricing_table` blocks.

Legal, consent and analytics:
25. Legal pages are pages of kind `legal` with a `legal_key`; terms versions are page versions; acceptances reference the exact version id. "Version n" shown to readers is the published ordinal from `v_legal_versions`.
26. Material terms changes show a non-blocking portal banner; commerce records acceptance at every checkout, so purchases always carry the current version.
27. The privacy notice must contain the controller's legal name from `settings.company.legal_name` (seeded "Vibrant Lifestyle Collective BV"); Sidestream seeds structure, BEAM supplies legal text (proposal: no legal advice).
28. Cookie categories `necessary`, `analytics`, `marketing`; consent cookie `beam_consent` for 182 days; consent log rows kept 395 days; GA4 loaded only after consent (basic consent mode, no cookieless pings), only on public pages in production; Vercel Analytics also waits for consent, on site and (through `PortalSiteChrome`) portal; nothing on admin.
29. UTM and landing path persist across pages (sessionStorage) only after analytics consent.
30. IPs in cookie consent logs are stored only as an HMAC with `AUTH_SECRET`; terms acceptances keep the plain IP as contract evidence, removed on erasure.
31. On erasure `terms_acceptances` are anonymised and kept (7-year retention with the invoices), `cookie_consents` deleted. Retention: consents 395 days, acceptances 2,555 days, Claude edit requests 730 days, all `delete`.

Portal, PWA, quality:
32. The site owns the portal layout `account/layout.tsx` (from Wave 1; platform-P6 writes only its first version, platform decision 63), the portal home page and `PortalSiteChrome`; platform owns the `PortalShell` component (navigation from `audience: 'customer'` nav entries), `loading.tsx`, `error.tsx`, `security/` and the sign-in pages, crm the profile, and each module its portal pages. Because site's own layout mounts the chrome, `PortalSiteChrome` is no longer exported from `api.ts` (this replaces site's earlier request that platform mount it). Account home reads the owners' `api.ts` functions; each card fails independently.
33. Profile editing is crm's page; the login email cannot be changed in the portal.
34. One service worker at scope `/` for site and portal (Serwist), network-first navigations, no offline writes, never handling `/admin` or `/api`; manifest `start_url` `/account?source=pwa` and `name` from `settings.company.trade_name`; icons generated with `ImageResponse` until BEAM supplies brand files.
35. Accessibility gate: axe with zero serious or critical violations on every V1 page template in Playwright; budgets LCP 2.5 s, CLS 0.1, INP 200 ms, 120 KB first-load JS, checked in the lab by `site-perf.spec.ts` and in the field from Vercel Analytics after go-live. An accessibility statement page is required (European Accessibility Act).
36. No site search, no personalised public pages, no A/B tests (Later).

Migration and build:
37. WordPress content comes from a WXR export file (no live WordPress API); WPML or Polylang translation groups become one multi-locale page; imported pages arrive as drafts and are published by staff, in bulk when complete; authors and comments are never imported.
38. Old URLs are covered by redirects for every page, post and attachment, with a coverage list; the real import is rehearsed on `staging` in week 7 before the DNS switch in week 8.
39. Module files are split into area files behind barrels (`actions.ts`, `queries.ts`, `jobs.ts`, `api.ts`) created by P1, so parallel packages never share a file; P1 writes the complete V1 `site` catalogue; e2e specs are split per area (`site-public`, `site-admin`, `site-claude`, `site-consent`, `site-a11y`, `site-perf`, `site-portal`, `site-events-r2`).
40. Seed content is development and demo only; production content comes from the import and BEAM staff.

Review additions:
41. House rules and the sauna health self-declaration are chapters of the `terms` document, so one versioned acceptance covers both; detailed health declarations are forms' seeded `health-declaration` form with sensitive routing and 365-day validity, never site content.
42. Page and version state machines are explicit (rules 54-56): `superseded` is added for proposals copied into a draft, and `restoreArchivedPage` makes `archived` reversible, so no state is a dead end by accident.
43. The stable event link `/<prefix>/events/<sessionId>` (rule 57) serves forms CTAs and emails without knowing localised paths; it is a 307 so it never gets indexed.
44. Opening hours come from booking's `settings.business_hours` (weekly) and `booking.getOpeningHours(db, { from, to })` (whole-centre closures and special hours), shown for 30 days ahead and in JSON-LD; the site stores no hours of its own and reads no booking table for them.
45. The footer carries the company identification required by the Belgian Code of Economic Law (book XII) from `settings.company`; missing data blocks go-live, not rendering.
46. Product purchase links go to commerce's guest checkout `/<prefix>/checkout?sku=` and gift vouchers to `/<prefix>/gift`; only bookings go through the portal. Prices come from `commerce.getProductPrice()`.
47. Public availability is a band from booking (`getAvailabilityPreview`, `listPublicEvents().availabilityBand`, or `bandFor(getAvailability())` on one event's detail page); the site never counts bookings itself.
48. The R3 referral code is a marketing cookie (`beam_ref`, 30 days), set only with marketing consent; crm resolves it at person creation through `site.readReferralCode()` and `credits.resolveReferralCode()`.
49. Reads of append-only site rows by person go through `crm.resolvePersonIds()`, because crm's merge does not rewrite append-only tables.
50. Every site table and column, including the R3 `pages.partner_company_id` and the R4 `site_audit_reports`, is created in site-P1, so later releases need no site migration.
51. Media accepts exactly platform's image mimes (PNG, JPEG, WebP, GIF); the YouTube facade poster is always a media-library image, so no Google host is contacted before a click.
52. Integrations are classified per blueprint 50 in section 6; the public site's uptime is watched by a Better Stack HTTP monitor on `/nl`, and the go-live runbook `docs/runbooks/site-go-live.md` covers rehearsal, DNS switch and rollback.

Cross-module alignment (review hand-off):
53. The `terms` document carries the chapters booking R62, commerce 26a and credits 57a rely on: general conditions, house rules, health self-declaration, cancellation policy, no right of withdrawal for date-specific leisure bookings (CEL art. VI.53, 12°) beside the 14-day withdrawal for undated purchases, and membership conditions. One `terms_acceptances` row per checkout (`context = 'checkout'`, `ref_type = 'order'`) or first booking (`context = 'booking'`) covers all of them, including membership terms; there is no separate membership legal key.
54. crm's request for legal kinds `house_rules`, `health_declaration` and `guardian_consent` is applied only for `guardian_consent` (new `pages_legal_key` value, rule 67): it is a separate document signed by a different person (the guardian) and backs crm's minor rule. `house_rules` and `health_declaration` are declined as separate legal documents: they conflict with booking R62 and site decision 41 (both chapters of `terms`, accepted once), and the health declaration with answers and its 365-day validity is already forms' `health-declaration` form (`hasValidSubmission`). Two versioned copies of the house rules would drift and force customers to accept twice. crm should check house rules through `site.hasAcceptedCurrentTerms(db, personId)` and the health declaration through `forms.hasValidSubmission(db, { personId, formSlug: 'health-declaration' })`, keeping `person_declarations` for `guardian_consent` (integrator item).
55. `getCurrentLegalVersion(db, key)` returns `{ versionId, version, publishedAt, requiresReacceptance, text, urlByLocale }`, crm's requested shape plus the fields commerce and booking already use; `ordinal` and `isMaterialChange` are renamed to `version` and `requiresReacceptance`. `LegalKey` covers every `pages_legal_key` value. `hasAcceptedCurrentTerms(db, personId)` keeps its signature (confirmed for booking and commerce).
56. Booking's published names are adopted: `listPublicEvents` for the events listing, `getAvailabilityPreview` (bands) for the `availability_preview` block, `getAvailability` only for one event's detail band, `getOpeningHours(db, { from, to })` for closures and special hours, and the single-person `listUpcomingBookingsForPerson(db, personId, limit)` and `listOpenOffersForPerson(db, personId)`; site's earlier `personIds[]` request is withdrawn because bookings and waitlist entries are mutable rows that crm's merge moves. Site no longer reads `session_exceptions`.
57. Forms' published names are adopted: `FormEmbed({ slug, locale, context: { pagePath, utm?, landingPath?, referrer?, partnerCompanyId? } })` (not `FormBlock`), forms signs the context, and `getPublishedFormMeta(db, slug)` is the publish check. The R3 referral code is not part of the embed context; crm reads `beam_ref` through `readReferralCode()` when forms' same-origin submit route creates the person.
58. Credits' `getPersonCreditSummary` returns an object (`byKind`, `membership`, `status`, `derivedStatus`); the balance card reads `byKind` and the membership card `getMembershipSummary`.
59. Webinar's `WebinarSignup({ webinarId, locale })` renders the R2 `webinar_signup` block and `listUpcomingRegistrationsForPerson` feeds the account-home webinar card; webinar owns `(site)/webinars/*` (incl. `[slug]/join`) and `(site)/w/[token]`, which stay reserved first path segments (rule 9). Commerce owns `(site)/{checkout,pay,gift}` (incl. `checkout/resume`); site creates none of them.
60. Every third-party browser script (GA4, Vercel Analytics, R3 Google Ads and Meta pixel) loads through `next/script` with the request nonce under platform's PL-67 `'strict-dynamic'` CSP; Vercel Analytics uses `/_vercel/insights/script.js`, so `@vercel/analytics` is not needed. The Serwist wrapper already sits in Wave 0's `next.config.ts` and switches on when site-P5 adds `app/sw.ts`; media and WXR files go through platform's `storeFile()`.
61. The site seed publishes version 1 of every seeded page (terms and guardian consent included) in `beam_dev`, previews and seeded test databases, because commerce refuses checkout without published terms in every environment; production stays unseeded.
62. Site's `privacy.ts` erase runs in its own transaction at the `site` position of ops' `ERASE_ORDER` (after `finance`, before `ops`, `crm` and `platform`); retention of the APPEND tables is ops' `privacy.retention_sweep` under `SET LOCAL beam.allow_rewrite = 'on'`. Email needs no change: `getLegalLinks(locale)` and `getEventPageUrl(db, sessionId, locale)` keep their signatures.
