# Module spec: site (Public website, portal shell)

Module id `site`. Owner paths: `packages/db/src/schema/site.ts`, `packages/db/src/schema/site.views.ts`, `packages/core/src/site/`, `apps/web/modules/site/`, `apps/web/app/[locale]/(site)/*` (except `f/[slug]`, owned by forms), `apps/web/app/(admin)/admin/site/*`, the portal shell `apps/web/app/[locale]/(portal)/account/{layout.tsx,page.tsx,profile/}`, `apps/web/app/{sitemap.ts,robots.ts,manifest.ts,sw.ts}`, `apps/web/app/pwa-icon/`, `apps/web/app/api/public/cookie-consent/`, `packages/integrations/src/wordpress/`, `packages/core/src/i18n/messages/*/site.json`, `packages/db/src/seed/site.ts`.

Blueprint sections: 10 (portal), 50 (Google Analytics, WordPress), 81 (app: responsive web first, PWA), 82 (no extra complexity for a future multi-client offer). Also used: 3 (origin), 15 (events), 16 (website forms, landing pages, UTM), 17 (result and booking CTAs), 19 (accurate availability, no public ranking), 45-46 (pricing), 53 (migration), 56 (audit), 57-63 (GDPR, cookies, retention), 64 (security), 76-77 (acceptance, go-live).

## 1. Purpose and release mapping

The site module replaces BEAM's WordPress website with a native, multilingual website at `/nl`, `/fr` and `/en`, edited by BEAM staff in the back-office and with Claude's help. It turns the catalogue (products, prices) and the booking calendar (event sessions) into public pages, embeds the forms module's lead forms, and sends visitors into the customer portal to book and buy. It also owns the portal shell (layout, navigation, account home, profile) that other modules' portal pages plug into, and the PWA manifest and service worker shared by site and portal.

| Release | Weeks | What this module ships |
| --- | --- | --- |
| V1 | 1-6 (live with the go-live in week 8, DNS switch from WordPress) | Pages and immutable page versions with blocks per locale; page kinds home, standard, offer, pricing, events index, event, blog index, post, contact, legal, landing; navigation menus; media library with alt text per locale; pricing tables from the catalogue; events listing and detail pages from booking sessions of kind `event`; availability previews and booking entry points into the portal; contact page and footer newsletter through forms' embed; blog/news with RSS; legal pages (privacy notice naming Vibrant Lifestyle Collective BV, versioned terms with acceptance records, cookie notice); SEO (metadata, hreflang, canonical, sitemap.xml, robots.txt, JSON-LD); cookie banner and consent-gated Vercel Analytics and Google Analytics 4; WCAG 2.1 AA and performance budgets; Claude-assisted editing with proposals, side-by-side diff review and publish; scheduled publishing; redirects; WordPress import (WXR export, mapping, media, redirects from old URLs); PWA manifest, icons, service worker, offline page and install prompt; portal shell, account home (upcoming bookings, balances, membership summary, open waitlist offers, quick actions, new-terms banner) and profile page |
| Release 2 | 9-10 | Events and ticketing extensions on public pages: ticket types with public and member prices, lead-magnet messaging ("Priority access for new guests until ..."), sold-out to waitlist entry; `webinar_signup` block and webinar landing pages; account home cards for upcoming webinars and guest invitations (guest and package-sharing controls) |
| Release 3 | 11-12 | Marketing consent category activates Google Ads conversion tag and Meta Pixel; partner landing pages (`pages.partner_company_id`) that stamp the partner on leads; landing-page insights screen (leads and orders per landing page and UTM campaign) for campaign attribution |
| Release 4 | 13-14 | Claude translation proposals that fill missing locales of a page; weekly Claude content and SEO audit report on the site dashboard |
| Later (out of scope) | after the build-out | Native mobile app (blueprint 81; the PWA covers V1), site search, A/B testing, personalised public content by customer status, gamification, multi-client theming for a BRANDEPIC offer (blueprint 82: content and branding are config, nothing more), headless CMS export |

## 2. Domain model

All tables live in `packages/db/src/schema/site.ts`; views in `site.views.ts`. Conventions from architecture section 2 apply (`id uuid pk default gen_random_uuid()`, `created_at timestamptz not null default now()`, `updated_at` on mutable tables, enums `pgEnum('<table>_<column>')`). `Locale` is the shared enum `nl-BE | fr-BE | en` from `_shared.ts`. Wave 0 created the contract table `pages` with minimal columns; P1 completes it without changing existing columns.

### Enums

| Enum | Values |
| --- | --- |
| `pages_kind` | `home, standard, offer, pricing, events_index, event, blog_index, post, contact, legal, landing` |
| `pages_status` | `draft, published, archived` |
| `pages_legal_key` | `privacy_notice, terms, cookie_notice` |
| `page_versions_state` | `draft, proposed, published, rejected` |
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

Constraints: unique `(page_id, version)`; partial unique `page_versions_one_draft_uq (page_id) where state = 'draft'`; check `(state = 'published') = (published_at is not null)`; check `state <> 'rejected' or rejected_at is not null`; check `created_by = 'user' or state in ('proposed','published','rejected')` (a Claude row is never a draft); check `scheduled_publish_at is null or state in ('draft','proposed')`. Indexes: `(page_id, state)`, `(scheduled_publish_at) where scheduled_publish_at is not null`, `(edit_request_id)`. Invariant (enforced in `server/versions.ts` and tested): an UPDATE on a row with `published_at is not null` is refused; only `draft` rows accept content updates; `proposed` rows accept only `state -> rejected|published`.

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

Check `(to_page_id is not null and to_locale is not null and to_url is null) or (to_page_id is null and to_locale is null and to_url is not null)`; check `to_url is null or to_url <> from_path`. Index `(to_page_id)`. A redirect to a page resolves to that page's current route at request time, so renames never create chains.

### `nav_menus` (mutable, history in `audit_log`)

Columns: id; key `nav_menus_key` not null unique; items jsonb not null default `'[]'` (`NavItem[]`, max 8 top-level items, max depth 2, max 12 children); version integer not null default 1 (optimistic lock, incremented on every save); updated_by_user_id uuid null FK users; created_at; updated_at. `NavItem = { id: string; label: LocalizedText; target: Link; children?: NavItem[] }`.

### `media_assets` (mutable)

Columns: id; file_id uuid not null unique FK `files.id` on delete restrict (file kind `image`, `is_public = true`); alt jsonb `LocalizedText` not null default `'{}'`; is_decorative boolean not null default false; width integer not null check `> 0`; height integer not null check `> 0`; caption jsonb `LocalizedText` null; credit text null `<= 200`; source `media_assets_source` not null default `'upload'`; wordpress_url text null; uploaded_by_user_id uuid null FK users; created_at; updated_at. Index `(source)`, unique partial `(wordpress_url) where wordpress_url is not null`. Allowed mimes: `image/jpeg, image/png, image/webp, image/avif, image/gif` (no SVG). Max 10 MB (the `files` limit).

### `page_edit_requests` (mutable)

Columns: id; page_id uuid not null FK pages; kind `page_edit_requests_kind` not null default `'edit'`; instruction text not null check `length between 3 and 4000`; locales text[] not null (target locales, default the base version's locales); base_version_id uuid null FK page_versions (null for `new_page` on an empty page); base_updated_at timestamptz null (snapshot of the base row's `updated_at`); status `page_edit_requests_status` not null default `'pending'`; requested_by_user_id uuid not null FK users; result_version_id uuid null FK page_versions; ai_request_id uuid null (no FK); error_code text null check in (`budget_exceeded`, `invalid_output`, `ai_unavailable`, `page_archived`); error_message text null; finished_at timestamptz null; created_at; updated_at. Partial unique `page_edit_requests_active_uq (page_id) where status in ('pending','running')`; index `(page_id, created_at desc)`.

### `terms_acceptances` APPEND

Columns: id; person_id uuid not null FK `persons.id`; page_version_id uuid not null FK `page_versions.id`; legal_key `pages_legal_key` not null (V1 writes `terms`; `privacy_notice` acknowledgements reuse it); context `terms_acceptances_context` not null; ref_type text null (`order`, `booking`, `user`); ref_id uuid null; ip text null (personal data, not sensitive); idempotency_key text not null unique (`terms:<person_id>:<page_version_id>:<context>:<ref_id|none>`); accepted_at timestamptz not null default now(); created_at. Index `(person_id, legal_key, accepted_at desc)`. Append-only trigger from `0002_append_only.sql` (table added to `APPEND_ONLY_TABLES`).

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

Prices are deliberately not part of any site view: an event's price comes from `booking.listPublicEvents()` (which returns the session's template `product_id`, and from R2 its `ticket_types`) combined with `commerce.listPublicPrices()`, so price rules stay in commerce.

### Tables of other modules this module reads or writes

| Table | Module | Access |
| --- | --- | --- |
| `sessions` | booking | read (view `v_site_events`, FK `pages.session_id`) |
| `products`, `price_versions` | commerce | read only through `commerce.listPublicPrices()` |
| `files` | platform | write through `platform.createFile()` (media, WXR upload); read through `/api/public/files/[id]` |
| `settings` | platform | read/write key `site` (new), read `company`, `business_hours` |
| `ai_requests` | platform | written by the AI gateway on every Claude call |
| `audit_log`, `jobs`, `activity_events` | platform, crm | written through `ctx.audit`, `ctx.enqueue`, `ctx.recordEvent` |
| `persons` | crm | FK from `terms_acceptances`, `cookie_consents`; profile writes through `crm.updatePersonDetails()` |
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
6. Cross-module references are checked at publish: `form_embed.formSlug` is a published form (`forms.getPublishedFormMeta`), `pricing_table.productIds` are active products, `booking_cta.sessionId` and `pages.session_id` are existing sessions of kind `event`, `link.pageId` targets are published or archived pages with a redirect. Any failure blocks publish.
7. Publishing is one transaction: lock the page row, set the version `published`, `published_at = ctx.now`, `published_by_user_id`; set `pages.current_version_id`, `status = 'published'`, `first_published_at` if null; rewrite `page_routes`; create rename redirects (rule 11); write `audit_log` `site.page.publish` with old and new version ids; then revalidate cache tags `site:page:<id>`, `site:routes`, `site:nav`, `site:sitemap`.
8. Only a staff user with `site.publish` publishes, schedules, unpublishes or archives. A version created by Claude can only be published by a human action; no job publishes a Claude version unless a human scheduled it.
9. Paths are lower-case `a-z0-9` words joined by hyphens, at most 3 segments, each at most 60 chars. The home page path is `''` and only the `home` page may use it. First segments `account, f, api, admin, preview, unavailable, offline, feed.xml, sitemap.xml, robots.txt, manifest.webmanifest, pwa-icon, _next` are reserved.
10. Exactly one non-archived page each of kind `home`, `events_index`, `blog_index`, `contact`, and one per `legal_key`.
11. When publishing changes a page's path in a locale, a redirect `source = 'rename'` is inserted from `/<prefix>/<old path>` to the page and locale. A redirect whose `from_path` equals a new live path is deleted in the same transaction, so the page wins.
12. Unpublish sets `status = 'draft'` and deletes the page's routes; archive sets `status = 'archived'` and deletes routes. Both may create one redirect (`source = 'archive'`) to a chosen target. Without one, an archived page's old paths answer 410 Gone, an unpublished page's paths 404.
13. Scheduled publishing: `scheduled_publish_at` must be at least 5 minutes and at most 365 days ahead. The job re-runs every publish check at the scheduled time; when a check fails the version stays unpublished, the schedule is cleared and the page shows a red "scheduled publish failed" issue on `/admin/site`.
14. A saved draft that was already scheduled keeps its schedule; discarding a draft cancels it.
15. Saving a draft uses optimistic locking: the action carries the `updated_at` it loaded; a mismatch returns `conflict` and nothing is written.
16. When a version is published while another draft exists whose `based_on_version_id` differs from the new live version, the editor marks that draft "out of date" and offers "keep" or "discard"; it is never merged automatically.

Blocks and content
17. Blocks are stored per locale. Each block has a stable `id` (uuid) unique within its locale list. The allowed types are defined once in `packages/core/src/site/blocks.ts` (section 4).
18. Exactly one `h1` per page: the `hero.heading` if the first block is a `hero`, otherwise the version title. `hero` is allowed only as the first block. Rich text allows `h2`-`h4` only.
19. Rich text is a structured document (`RichDoc`, Tiptap-compatible JSON) with paragraphs, headings 2-4, bullet and numbered lists, blockquote, bold, italic and links. It is rendered by an in-house renderer; no HTML string is ever injected.
20. External links open in the same tab and get `rel="noopener"`; `href` must be `https:`, `mailto:`, `tel:` or a site path. `javascript:` and `data:` are rejected by the Zod schema.
21. A `testimonial` block requires `consentConfirmed: true` (the staff member confirms the person agreed to be quoted).
22. A `video` block embeds YouTube only through `youtube-nocookie.com` behind a click-to-load facade with poster image; nothing loads from Google until the visitor clicks.
23. A `map` block is a static image with a link to the map provider; no third-party map iframe is embedded.
24. Navigation items whose target page is unpublished, archived or not available in the current locale are hidden in that locale and listed as content issues.

Catalogue, events and booking entry points
25. Prices on the site come only from `commerce.listPublicPrices()` and are shown VAT included, formatted with `Intl.NumberFormat(locale, { style: 'currency', currency: 'EUR' })`. The site never stores a price amount.
26. A `pricing_table` shows the public price and, when the product has a member price or `member_discount_pct > 0`, the line "Members: <amount>". Inactive products are omitted from the rendered table and flagged as issues.
27. Dynamic data blocks (prices, events, availability) are cached for at most 300 seconds; a price or session change is visible on the site within 5 minutes.
28. The events listing shows sessions of kind `event` with `starts_at >= now()` and status `open` or `closed`, ordered by `starts_at`, 12 per page. Cancelled sessions are not listed. `closed` or full sessions show "Full" with a "Join the waitlist" entry point.
29. An event detail page for a past session stays reachable with a "This event has taken place" banner, is excluded from the sitemap and gets `noindex` 30 days after `ends_at`. A cancelled session's page shows "This event was cancelled" and `noindex`.
30. Seats left are shown only as bands: "Available", "Few places left" (fewer than 5, or below 10 % of capacity) and "Full". No exact counts and no queue position are ever shown publicly (blueprint 19).
31. Booking entry points link into the portal: `/<prefix>/account/book?kind=day|night`, `/<prefix>/account/book/<sessionId>` and `/<prefix>/account/shop/<sku>`. A visitor without a customer session goes through the magic-link sign-in and returns to that URL (`callbackUrl`).
32. A member-only session shows a "Members only" badge; its booking button still links to the portal, where booking enforces eligibility.

Legal, consent and analytics
33. The privacy notice must contain the controller's legal name from `settings.company.legal_name` (seeded `Vibrant Lifestyle Collective BV`) in every locale; publish fails otherwise.
34. The current terms are the `terms` page's live version. `recordTermsAcceptance()` is idempotent on its key and writes activity event `site.terms_accepted`.
35. When a terms version with `is_material_change = true` is published, every customer whose latest `terms` acceptance is for an older version sees a non-blocking banner on all portal pages until they accept; bookings with existing credit are never blocked by it.
36. The cookie banner offers "Accept all", "Reject all" and "Choose" with equal visual weight; no box is pre-ticked; categories are `necessary` (always on, not a choice), `analytics`, `marketing` (R3 tags).
37. No analytics script (Vercel Analytics, Google Analytics) is requested before analytics consent. GA4 loads only on public site pages, only in production (`VERCEL_ENV = 'production'`), only when `settings.site.analytics_enabled` and `ga_measurement_id` are set; it is initialised with Consent Mode v2 `analytics_storage: 'granted'`, `ad_storage`, `ad_user_data`, `ad_personalization: 'denied'` (granted only with marketing consent from R3). Vercel Analytics loads on site and portal pages after analytics consent. The admin never loads analytics.
38. The consent cookie lives 182 days. The banner reappears when it is older, when it is missing, or when the cookie notice's published ordinal is higher than the cookie's version and that version was a material change. "Cookie settings" in the footer reopens the choice at any time; withdrawing deletes `_ga*` cookies set on the site domain.
39. Every banner choice writes one `cookie_consents` row; the cookie holds only `{k, v, a, m, t}` (key, banner version, analytics, marketing, epoch seconds).
40. UTM parameters and the landing path are kept in `sessionStorage` for the visit only after analytics consent; without consent they are passed to a form only when the form is on the landing page itself.

Claude-assisted editing
41. Asking Claude requires `site.edit` and `ai.use`. One active request per page; a second returns `conflict`.
42. Claude receives the base version's content, the instruction, the block schema, brand voice from `settings.site.brand_voice`, and reference lists (product ids and names, upcoming event session ids and titles, form slugs, page ids and titles). It receives no personal data; the `ai_requests.fields_sent` value is `['page_content','instruction','catalogue_refs']`.
43. Claude's output must parse as `ProposalOutput`; one repair round is allowed; a second failure ends the request with `invalid_output` and no version.
44. The proposal keeps the ids of blocks it keeps or changes; new blocks get new ids. It may not change `pages.kind`, `legal_key`, `session_id` or remove a locale from `locales`.
45. Review warnings (non-blocking, shown on the diff) flag: a currency amount in text, a changed path, removed blocks, a changed legal page, text longer than limits.
46. A proposal is either published, rejected with a reason, or copied into the draft ("Edit as draft"); it is never edited in place.

Portal shell and profile
47. Every portal query filters on `ctx.actor.personId`. Account home shows at most 5 upcoming bookings (own and guest bookings made by the person), credit balances per kind with the nearest expiry, the membership summary, open waitlist offers with their expiry, and quick actions.
48. Profile edits change first name, last name, phone, address, preferred locale and birth date through `crm.updatePersonDetails()`; changing the login email is not possible in the portal (staff action in crm).
49. Changing the preferred locale in the profile changes `persons.locale` (emails) and redirects the portal to the new prefix.

Accessibility and performance
50. Every public and portal page meets WCAG 2.1 AA: `lang` equals the locale, skip link, landmarks, visible focus, keyboard-operable menus and dialogs, reduced-motion respected, contrast from `packages/ui` tokens, no axe violations of impact `serious` or `critical` in the e2e suite.
51. Budgets at p75 on mobile: LCP <= 2.5 s, CLS <= 0.1, INP <= 200 ms; first-load JavaScript on content pages <= 120 KB gzip. Images use `next/image` with stored width and height.

WordPress migration
52. Only WXR items with status `publish` default to `import`; drafts and private items default to `skip`. Imported pages and posts are created as drafts (single version, `created_by = 'user'`, `created_by_user_id` = importer) and need a human publish.
53. Every imported item's old path gets a redirect to its new page (or `redirect_only` target); every imported attachment's old URL redirects to its file URL. The import screen lists every old path that resolves to neither a page nor a redirect.

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
  | { id; type: 'booking_cta'; label: string; target: { kind: 'book_day'|'book_night' } | { kind: 'session'; sessionId: string } | { kind: 'buy_product'; productId: string } }
  | { id; type: 'video'; youtubeId: string; title: string; posterMediaId?: string }
  | { id; type: 'testimonial'; quote: string; authorName: string; authorDetail?: string; consentConfirmed: true }
  | { id; type: 'contact_details'; showAddress: boolean; showPhone: boolean; showEmail: boolean; showOpeningHours: boolean }
  | { id; type: 'map'; mediaId: string; linkUrl: string }
  | { id; type: 'legal_meta' }                                    // "Version n, last updated <date>"; legal pages only
  | { id; type: 'webinar_signup'; webinarId: string };            // R2
```

Pure functions: `BlocksByLocale` (Zod), `parseBlocks(locale, json): Block[]`, `normalisePath(raw): string`, `isReservedPath(path): boolean`, `localeFromPrefix('nl'|'fr'|'en'): Locale`, `prefixFromLocale(Locale)`, `checkPublishable(version: VersionContent, refs: RefFacts): PublishIssue[]` (`PublishIssue = { locale?: Locale; blockId?: string; code: string; message: string }`), `collectRefs(version): { mediaIds; formSlugs; productIds; sessionIds; pageIds; webinarIds }`, `diffVersions(base: VersionContent | null, next: VersionContent): VersionDiff` (pairs blocks by `id`; per field `{ op: 'eq'|'ins'|'del'; text }[]` from a word-level LCS `diffWords(a, b)`), `reviewWarnings(base, next): Warning[]`, `buildJsonLd(kind, facts): object[]`, `encodeConsentCookie / decodeConsentCookie`, `imageSize(bytes: Uint8Array): { width; height; mime } | null` (PNG, JPEG, WebP, GIF, AVIF headers), `richDocToPlainText(doc)`.

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
| `archivePage` | staff, `site.publish` | `{ pageId, redirectTo?: Link }` | `{ ok }` | `site.page.archive` |
| `updateNavMenu` | staff, `site.publish` | `{ key, items: NavItem[], expectedVersion }` | `{ version }` | `site.nav.update` (old/new items) |
| `upsertRedirect` | staff, `site.publish` | `{ id?, fromPath, to: { pageId, locale } \| { url }, isPermanent }` | `{ id }` | `site.redirect.upsert` |
| `deleteRedirect` | staff, `site.publish` | `{ id }` | `{ ok }` | `site.redirect.delete` |
| `uploadMedia` | staff, `site.edit` | `FormData { file (<= 10 MB, allowed mime), alt: LocalizedText partial, isDecorative }` | `{ mediaId, fileId }` | `site.media.upload` |
| `updateMedia` | staff, `site.edit` | `{ mediaId, alt, isDecorative, caption?, credit? }` | `{ ok }` | `site.media.update` |
| `deleteMedia` | staff, `site.edit` | `{ mediaId }` | `{ ok }` or `conflict` when referenced by a draft, proposal or live version | `site.media.delete` |
| `updateSiteSettings` | staff, `site.publish` | `SiteSettings` partial | `{ version }` | `site.settings.update` |
| `requestProposal` (`site.proposal.request`) | staff, `site.edit` + `ctx.require('ai.use')` | `{ pageId, instruction (3-4000), locales?: Locale[], kind: 'edit'\|'new_page' }` | `{ editRequestId }`; enqueues `site.propose_page` | `site.proposal.request` |
| `cancelProposalRequest` | staff, `site.edit` | `{ editRequestId }` | `{ ok }` (only while `pending`) | `site.proposal.cancel` |
| `rejectProposal` | staff, `site.edit` | `{ versionId, reason (1-500) }` | `{ ok }` | `site.proposal.reject` |
| `copyProposalToDraft` | staff, `site.edit` | `{ versionId, replaceExisting: boolean }` | `{ versionId }` | `site.proposal.copy_to_draft` |
| `startWordpressImport` | staff, `site.publish` | `FormData { file (.xml, <= 10 MB), siteOrigin, defaultLocale }` | `{ importId }`; enqueues `site.wp_parse` | `site.wp_import.start` |
| `updateImportItem` | staff, `site.publish` | `{ itemId, decision, locale?, translationGroup?, redirectToPageId? }` | `{ ok }` | `site.wp_import.update_item` |
| `applyWordpressImport` | staff, `site.publish` | `{ importId }` | `{ ok }`; enqueues `site.wp_apply` offset 0 | `site.wp_import.apply` |
| `publishImportedPages` | staff, `site.publish` | `{ importId }` | `{ published: number, blocked: { pageId, issues }[] }` | `site.page.publish` per page |
| `acceptCurrentTerms` | customer | `{ versionId }` | `{ ok }` | event `site.terms_accepted` |
| `updateMyProfile` | customer | `{ firstName, lastName, phone?, address?: { street, postalCode, city, country }, locale, birthOn? }` | `{ ok, redirectTo? }` | crm writes its own event and audit |

### Queries (`queries/<area>.ts`; read through `getDb()`, public ones wrapped in `unstable_cache` with tags)

- Public: `getPageByPath(locale, path): Promise<ResolvedPage | null>` (tags `site:routes`, `site:page:<id>`), `resolveRequest(locale, segments, searchParams): Promise<{ kind: 'page'; page } | { kind: 'redirect'; to; permanent } | { kind: 'gone' } | { kind: 'not_found' }>`, `getNavMenus(locale)` (tag `site:nav`), `listPublicEventsForSite(locale, { page, limit, showFull })` (revalidate 300, tag `site:events`), `listPosts(locale, { page, limit })`, `getPricingRows(productIds, locale)` (revalidate 300, tag `site:prices`), `getSitemapEntries()` (tag `site:sitemap`), `getLegalLinks(locale)`.
- Admin: `listPagesForAdmin({ kind?, status?, q? })`, `getPageEditor(pageId)`, `getVersion(versionId)`, `getVersionDiff(versionId)`, `listVersionHistory(pageId)`, `getEditRequest(id)` (polled every 2 s by the Claude panel), `listMedia({ q?, cursor })`, `listRedirects({ q?, source?, cursor })`, `getContentIssues()`, `getWordpressImport(id)`, `listWordpressImportItems(importId, filter)`, `getRedirectCoverage(importId)`.
- Portal: `getAccountHome(personId, locale)`, `getProfile(personId)`, `getTermsBannerState(personId)`.

### Route handlers and metadata routes

| Route | Method | Behaviour |
| --- | --- | --- |
| `app/[locale]/(site)/[[...path]]/page.tsx` | GET | resolves path, renders page or redirects (308/307), 404, 410; `generateMetadata` from `seo[locale]`, canonical, `alternates.languages` (hreflang for each live locale plus `x-default` = nl-BE or first locale); `revalidate = 3600` |
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
| `site.propose_page` | fast, 5 | `site:propose:<edit_request_id>` | 3, 120 s | no-op if the request is not `pending`/`running` or already has `result_version_id`; sets `running`; calls the platform AI gateway (`claude-opus-5-5`, max 16,000 output tokens, structured output from `ProposalOutput`); validates; one repair call; inserts the `proposed` version and sets the request `succeeded` in one transaction. `budget_exceeded` and `invalid_output` are `PermanentError` (request `failed`); provider 5xx and timeouts are `RetryableError`; on the last failed attempt the request becomes `failed` with `ai_unavailable` |
| `site.publish_version` | fast, 3 | `site:publish:<version_id>:<schedule epoch>` | 6, 30 s | publishes at `run_at` only if the version is still `draft`/`proposed` and `scheduled_publish_at` equals the payload; failed checks clear the schedule and write audit `site.page.schedule_failed` (no retry) |
| `site.wp_parse` | bulk, 9 | `site:wp:<import_id>:parse` | 3, 120 s | parses the WXR file into `wordpress_import_items` (upsert on `(import_id, wp_type, wp_id)`), drops authors and comments, sets `parsed` and counts |
| `site.wp_fetch_media` | bulk, 9 | `site:wp:<import_id>:media:<n>` | 6, 120 s | downloads 20 attachments per job through the `wordpress` client, creates `files` + `media_assets` (skip if `wordpress_url` exists), enqueues `n + 1` until done |
| `site.wp_apply` | bulk, 9 | `site:wp:<import_id>:apply:<offset>` | 6, 120 s | converts 50 items per job into pages (draft v1) and redirects, sets item status, enqueues the next offset; the first run enqueues `site.wp_fetch_media` n = 0; the last sets `done` |
| `site.seo_audit` (R4) | bulk, 9 | `schedule:site.seo_audit:<minute>` | 3, 300 s | Haiku pass per page for missing or weak SEO texts and broken references; inserts `site_audit_reports` for the week (on conflict do nothing) |

A double run of every job yields the same database state (`jobs.test.ts`).

### Schedules (`schedules.ts`, Europe/Brussels)

V1: none (publishing uses `run_at`). R4: `site.seo_audit` every Monday at 07:10 (`10 7 * * 1`).

### Activity events and permissions declared

`events.ts`: `site.terms_accepted` (person; `ref_type = 'page_version'`, `data = { legal_key, context, version_ordinal }`, `dedupe_key = <terms idempotency_key>`). `permissions.ts` declares `site.edit` and `site.publish` (architecture strings; no new permission).

### Cross-module API (`modules/site/api.ts`)

```ts
export type LegalKey = 'privacy_notice' | 'terms' | 'cookie_notice';
export type TermsContext = 'checkout' | 'signup' | 'booking' | 'portal_prompt' | 'pos' | 'import';
export function getCurrentLegalVersion(db: DbOrTx, key: LegalKey): Promise<{ versionId: string; ordinal: number; publishedAt: Date; isMaterialChange: boolean; urlByLocale: Partial<Record<Locale, string>> } | null>;
export function recordTermsAcceptance(tx: Tx, ctx: Ctx, input: { personId: string; versionId: string; context: TermsContext; refType?: 'order' | 'booking' | 'user'; refId?: string; ip?: string | null }): Promise<{ acceptanceId: string; created: boolean }>;
export function hasAcceptedCurrentTerms(db: DbOrTx, personId: string): Promise<boolean>;
export function getLegalLinks(locale: Locale): Promise<{ privacy: string | null; terms: string | null; cookies: string | null }>; // absolute URLs for email footers and checkout
export function getPageUrl(db: DbOrTx, ref: { pageId: string } | { slug: string }, locale: Locale): Promise<string | null>; // absolute URL or null
export function getEventPageUrl(db: DbOrTx, sessionId: string, locale: Locale): Promise<string | null>; // event page, or the portal booking URL when no page exists
export type PortalRoute = 'home' | 'book_day' | 'book_night' | 'shop' | 'packages' | 'membership' | 'invoices' | 'preferences';
export function portalUrl(locale: Locale, route: PortalRoute, params?: Record<string, string>): string; // site-relative, e.g. /nl/account/book?kind=day
export function getSiteSettings(db: DbOrTx): Promise<SiteSettings>;
```

`SiteSettings` (`settings` key `site`): `{ canonicalOrigin: string (default 'https://www.beam.be'); analyticsEnabled: boolean (false); gaMeasurementId: string | null (/^G-[A-Z0-9]{4,12}$/); defaultOgImageMediaId: string | null; socialLinks: { instagram?, facebook?, linkedin?, youtube? }; brandVoice: string (<= 4000); googleAdsConversionId: string | null (R3); metaPixelId: string | null (R3) }`.

## 5. Screens

All screens use `packages/ui` components. Every list has an empty state, a skeleton while loading (`loading.tsx`) and an `error.tsx` boundary with a retry button and the request id; action errors show the mapped `error.message` inline next to the control that caused them.

### Staff back-office (`/admin/site/...`, nav group "Website" from `nav.ts`, visible with `site.edit`)

| Route | Shows | Actions | Empty / error | Who |
| --- | --- | --- | --- | --- |
| `/admin/site` | Pages table (title in the staff locale, kind, status, live version, draft and proposal badges, last published), content issues panel (blocking publish issues of drafts, scheduled-publish failures, nav items to hidden pages, references to inactive products or past events, missing legal pages as a red go-live banner), open Claude requests | filter by kind and status, search, "New page" | "No pages yet: create the home page or import from WordPress" | `site.edit` |
| `/admin/site/pages/new` | Form: kind, slug, title per locale, locales, legal key (legal), session picker (event) | create | slug conflict inline | `site.edit` |
| `/admin/site/pages/[pageId]` | Editor with locale tabs (completeness badge per tab), block list (add, edit, move up/down, duplicate, delete, "copy blocks from nl-BE"), per-block forms with media, link, product, form and session pickers, SEO tab (title and description counters, OG image, noindex), paths, excerpt, cover, material-change switch (legal), issue list from `checkPublishable`, history (versions with state, author or "Claude for <user>", published date, Restore), Claude panel | Save draft (Ctrl+S), Preview (opens `/<prefix>/preview/<versionId>`), Publish now, Schedule, Unpublish, Archive (with redirect picker), Ask Claude | stale-draft banner (rule 16); conflict on save shows "Someone else saved this page; reload" | edit: `site.edit`; publish controls hidden without `site.publish`; Claude panel hidden without `ai.use` |
| `/admin/site/pages/[pageId]/versions/[versionId]` | Side-by-side diff of the version against its `based_on_version_id` (or the live version): locale switch, title, paths, SEO, per-block changes with word-level insertions and deletions, added and removed blocks; review warnings; toggle to rendered previews (two iframes); for Claude versions the instruction, the change summary and the requester | Publish, Schedule, Reject (reason), Edit as draft | "This version is identical to the live version" | view `site.edit`; publish `site.publish` |
| `/admin/site/navigation` | Header, footer and legal menus as editable trees with label per locale and target picker | add, edit, reorder, remove, Save (version check) | "No items: the header shows only the logo" | `site.publish` to save, `site.edit` to view |
| `/admin/site/media` | Grid of images with alt completeness, size, usage count | upload (drag and drop or file picker), edit alt per locale, decorative switch, caption, credit, delete | "No images yet" | `site.edit` |
| `/admin/site/redirects` | Table: from, to, source, permanent, hits, last hit | add, edit, delete, filter by source, search, CSV export of the table | "No redirects" | view `site.edit`, change `site.publish` |
| `/admin/site/imports` | WordPress imports with status and counts | upload WXR with site origin and default locale | "No imports" | `site.publish` |
| `/admin/site/imports/[importId]` | Items table (type, WP status, title, old path, locale, translation group, decision, status, message), redirect coverage list, report of stripped shortcodes and unsupported markup | change decision, locale, group, redirect target; Apply import; Publish complete imported pages | parse errors shown with line numbers | `site.publish` |
| `/admin/site/settings` | Canonical origin, analytics switch, GA measurement id, default OG image, social links, brand voice for Claude; R3 Google Ads and Meta Pixel ids | save (version check) | | `site.publish` |
| `/admin/site/insights` (R3) | Per landing page and UTM campaign: form submissions, new persons, orders and revenue in the period | date range, export CSV | "No tracked landings in this period" | `reports.read` and `site.edit` |

The Claude panel (inside the editor): instruction textarea (character counter), locale checkboxes, "Ask Claude"; while running a progress line polling `getEditRequest` every 2 s for up to 3 minutes; on success "Proposal ready: review" linking to the diff; on failure the decided message per `error_code` ("AI budget reached for this month", "Claude returned an invalid page, try a more specific instruction", "Claude is unavailable, edit manually").

### Customer portal (`/[locale]/account/...`, audience customer)

| Route | Shows | Actions | Empty / error |
| --- | --- | --- | --- |
| `account/layout.tsx` (shell) | Header with logo, portal navigation (entries from every module's `nav.ts` with `audience: 'portal'`, sorted by `order`), locale switch, sign out; terms banner (rule 35); install prompt; footer with legal links; skip link | switch locale, sign out, accept terms, install | if a module's data fails, its card shows "Temporarily unavailable" and the shell still renders |
| `account` (home) | Greeting with first name; next 5 upcoming bookings (date, time, kind, guest marker, link to booking detail); balances per credit kind ("4 sessions remaining", nearest expiry); membership card (status, current period end, included credits, "Renew" link when `past_due`); open waitlist offers with countdown and Claim button; quick actions: Book a day session, Book a night, Buy a package, View invoices, Communication preferences; R2: upcoming webinars, Invite a guest | follow links into booking, commerce, credits, finance and crm pages | "No upcoming bookings: book your first session" with Book button; "No active package" with Buy button |
| `account/profile` | First name, last name, email (read-only with "contact us to change"), phone, address, preferred language, birth date | Save | field errors inline |

PWA: `manifest.webmanifest` with `name: 'BEAM Vitality Center'`, `short_name: 'BEAM'`, `start_url: '/account?source=pwa'`, `scope: '/'`, `display: 'standalone'`, `background_color` and `theme_color` from `packages/ui` tokens, icons 192, 512 and 512 maskable. The service worker (`app/sw.ts`, Serwist) precaches build assets and `/nl/offline`, `/fr/offline`, `/en/offline`; `/_next/static` cache-first; images stale-while-revalidate (7 days, 200 entries); navigations network-first with a 3-second timeout and the offline page as fallback; it never handles `/admin/*`, `/api/*` or non-GET requests, and never serves account pages from cache when the network answers. The install prompt captures `beforeinstallprompt` and shows an "Install the BEAM app" card on account home from the second portal visit; on iOS Safari it shows the "Share, Add to Home Screen" instruction; dismissal is remembered in `localStorage` for 90 days.

### Public (`/[locale]/...`, audience everyone)

| Route | Shows | Notes |
| --- | --- | --- |
| `/[locale]` | home page blocks; JSON-LD `LocalBusiness` + `HealthAndBeautyBusiness` (name "BEAM Vitality Center", legalName from settings, address, opening hours, logo, sameAs) | 404 page with navigation if no home is published |
| `/[locale]/<path>` | any published page: standard, offer, pricing, landing, contact (with `form_embed` of form `contact` and `contact_details`), legal (with `legal_meta`), events index (`events_list`), event detail (session date, time, location, price, availability band, "Get tickets" or "Join the waitlist", JSON-LD `Event`), blog index (`posts_list`, `?page=n`), post (cover, date, JSON-LD `BlogPosting`), FAQ blocks add `FAQPage`, nested paths add `BreadcrumbList` | header and footer from `nav_menus`; footer newsletter `form_embed` of form `newsletter`; "Cookie settings" link |
| `/[locale]/unavailable?page=<id>` | "This page is not available in <language>" with links to its live locales | `noindex` |
| `/[locale]/preview/<versionId>` | rendered version with a "Preview, not published" ribbon | staff only |
| Cookie banner and settings dialog | on every public and portal page until a choice exists | dialog is a focus-trapped modal opened from the banner or footer; the banner itself is a non-modal region at the bottom |
| 404 / 410 | localised, with search-free navigation back to home and events | status codes 404 and 410 |

## 6. Integrations

| Service | Client | Calls | Failure handling | Idempotency |
| --- | --- | --- | --- | --- |
| Claude (Anthropic) | `packages/integrations/src/anthropic/` through the platform AI gateway (`platform.runAi`, section 10); tests use `anthropic/fake.ts` with scripted responses | `site.propose_page` (and `translate` from R4): one `messages.create` with `claude-opus-5-5`, stable system prompt marked `cache_control: { type: 'ephemeral' }`, structured JSON output from `z.toJSONSchema(ProposalOutput)`; one repair call on invalid output. R4 `site.seo_audit` uses `claude-haiku-5-5` | gateway budget refusal -> `PermanentError`, request `failed` / `budget_exceeded`; 429, 5xx, timeout -> `RetryableError` (backoff 60 s, 300 s), last attempt -> `ai_unavailable`; the editor always works without AI | job key `site:propose:<edit_request_id>`; the result is written only if `result_version_id` is null |
| WordPress (old site) | new `packages/integrations/src/wordpress/client.ts` + `fake.ts`: `class WordpressMediaClient { constructor(opts: { allowedOrigin: string; timeoutMs?: number; maxBytes?: number; onCall: IntegrationCallLogger }); fetchMedia(url: string): Promise<{ bytes: Uint8Array; mime: string; sizeBytes: number }> }` | `site.wp_fetch_media`: GET each attachment URL; only URLs on `allowedOrigin` (the import's `site_origin`) or its `/wp-content/uploads/` CDN host listed in the file; 20 s timeout; 10 MB max | 404 or 410 -> item `error` "media missing", continue; mime not allowed -> `error`; 5xx or network -> `RetryableError` for the chunk; every call logged in `integration_calls` (provider `wordpress`, never bodies) | `media_assets.wordpress_url` unique; a re-run skips fetched URLs |
| Google Analytics 4 | browser only: `https://www.googletagmanager.com/gtag/js?id=<id>` injected by `ui/public/analytics-loader.tsx` after consent | page views (automatic), no custom events in V1; IP handling is GA4's default (no IP storage) | script load failure is ignored | none |
| Vercel Analytics | browser only: `@vercel/analytics/react` `<Analytics />` mounted by the loader after consent | page views | none needed | none |
| YouTube | browser only: `youtube-nocookie.com/embed/<id>` iframe created on click | none server-side | iframe failure shows the link to YouTube | none |
| Google Ads, Meta Pixel (R3) | browser only, marketing consent | conversion tag on form success and order paid return page | ignored | none |

The site makes no other server-side external calls. Images are served by the platform's `/api/public/files/[id]` and optimised by `next/image` on Vercel.

## 7. Permissions and audit

| Role (default set) | site.edit | site.publish | ai.use | Can do |
| --- | --- | --- | --- | --- |
| owner, technical_admin, management | yes | yes | yes | everything in this module |
| marketing | yes | yes | yes | everything in this module |
| customer_service, sales, finance, reception, external_partner | no | no | sales: yes | nothing in `/admin/site` (nav hidden, server refuses) |
| customer | n/a | n/a | n/a | own account home, own profile, accept terms |
| anonymous visitor | n/a | n/a | n/a | public pages, cookie choice |

Rules: viewing any `/admin/site` screen requires `site.edit`; publishing, scheduling, unpublishing, archiving, navigation, redirects, site settings and WordPress import require `site.publish`; Claude requests require `site.edit` and `ai.use`; the R3 insights screen also requires `reports.read`. Customers' actions are scoped to `ctx.actor.personId`.

Audited (`audit_log`, written by the `action()` wrapper with old and new values): every action in section 4 with its audit action name: `site.page.create`, `site.page.save_draft` (old/new store `{ versionId, sha256 of content }`, not the content), `site.page.restore`, `site.page.discard_draft`, `site.page.publish`, `site.page.schedule`, `site.page.unschedule`, `site.page.schedule_failed` (system actor), `site.page.unpublish`, `site.page.archive`, `site.nav.update`, `site.redirect.upsert`, `site.redirect.delete`, `site.media.upload`, `site.media.update`, `site.media.delete`, `site.settings.update`, `site.proposal.request`, `site.proposal.cancel`, `site.proposal.reject`, `site.proposal.copy_to_draft`, `site.wp_import.start`, `site.wp_import.update_item`, `site.wp_import.apply`. Publishing a Claude version records `new_value.created_by = 'claude'` and the `edit_request_id`, so "who approved which AI text" is answerable from the audit log. Customer actions are not staff writes and are not audited; `acceptCurrentTerms` leaves the `terms_acceptances` row and the timeline event instead.

## 8. Multi-language and content

Content fields (staff-edited, stored in the database):
- Per-locale structures (one value per locale, not `LocalizedText` objects inside): `page_versions.blocks`, `page_versions.seo`, `page_versions.paths`. Inside a locale's block list every text is a plain string in that locale.
- `LocalizedText` jsonb: `page_versions.title`, `page_versions.excerpt`, `media_assets.alt`, `media_assets.caption`, `nav_menus.items[].label`.
- Not translated: `pages.slug` (internal), `redirects`, `settings.site.brand_voice` (English, read by Claude).

Publish-time completeness (blocking, for every locale in `version.locales`): the checks of rule 5, plus `assertComplete(title, locales)`, `assertComplete(excerpt, locales)` where required, `assertComplete(media.alt, locales)` for each referenced non-decorative image, and the legal-name check of rule 33. Saving a navigation menu calls `assertComplete(label, ['nl-BE','fr-BE','en'])` for every item (menus serve all three locales; an item for a page missing a locale is hidden there, rule 24). A page may declare fewer locales; a visitor of another locale gets `/[locale]/unavailable`, never a mixed page. Dates use `Intl.DateTimeFormat(locale, { timeZone: 'Europe/Brussels' })`, money `Intl.NumberFormat` EUR. The locale switch links to the same page's route in the target locale, or to `unavailable` when it has none.

UI strings: namespace `site` in `packages/core/src/i18n/messages/{en,nl-BE,fr-BE}/site.json`, keys `site.<screen>.<element>`, `en` the source. P1 writes the complete V1 key set in all three locales; R2-R4 packages add their keys. Key groups (each group lists every key P1 must create):
- `site.public.*`: `skipLink`, `menu.open`, `menu.close`, `localeSwitch.label`, `footer.cookieSettings`, `footer.legal`, `footer.newsletterHeading`, `notFound.title`, `notFound.body`, `notFound.home`, `gone.title`, `gone.body`, `unavailable.title`, `unavailable.body`, `offline.title`, `offline.body`, `preview.ribbon`, `breadcrumb.home`.
- `site.blocks.*`: `pricing.from`, `pricing.members`, `pricing.vatIncluded`, `pricing.sessions` (ICU plural), `pricing.validity` (plural days), `events.empty`, `events.full`, `events.fewLeft`, `events.available`, `events.membersOnly`, `events.getTickets`, `events.joinWaitlist`, `events.past`, `events.cancelled`, `events.more`, `availability.title`, `availability.book`, `availability.none`, `posts.empty`, `posts.readMore`, `posts.newer`, `posts.older`, `video.play` (with `{title}`), `video.consentNote`, `map.open`, `legal.version` (`Version {n}`), `legal.updated` (`Last updated {date}`), `contact.address`, `contact.phone`, `contact.email`, `contact.openingHours`, `contact.closed`.
- `site.cookies.*`: `banner.title`, `banner.body`, `banner.acceptAll`, `banner.rejectAll`, `banner.choose`, `dialog.title`, `dialog.necessary.title`, `dialog.necessary.body`, `dialog.analytics.title`, `dialog.analytics.body`, `dialog.marketing.title`, `dialog.marketing.body`, `dialog.save`, `dialog.noticeLink`.
- `site.portal.*`: `nav.home`, `nav.profile`, `nav.signOut`, `home.greeting` (`{firstName}`), `home.upcoming`, `home.noBookings`, `home.bookFirst`, `home.guest`, `home.balance`, `home.remaining` (plural per kind: day sessions, nights, euro credit), `home.expires`, `home.noPackage`, `home.buyPackage`, `home.membership`, `home.membershipActive`, `home.membershipPastDue`, `home.renew`, `home.offers`, `home.offerExpires`, `home.claim`, `home.quick.bookDay`, `home.quick.bookNight`, `home.quick.buyPackage`, `home.quick.invoices`, `home.quick.preferences`, `home.unavailableCard`, `terms.banner`, `terms.read`, `terms.accept`, `install.title`, `install.body`, `install.button`, `install.ios`, `install.dismiss`, `profile.title`, `profile.firstName`, `profile.lastName`, `profile.email`, `profile.emailHelp`, `profile.phone`, `profile.street`, `profile.postalCode`, `profile.city`, `profile.country`, `profile.language`, `profile.birthOn`, `profile.save`, `profile.saved`.
- `site.admin.*`: navigation labels (`nav.website`, `nav.pages`, `nav.navigation`, `nav.media`, `nav.redirects`, `nav.imports`, `nav.settings`), page kinds (`kind.<each pages_kind>`), statuses and states, block type names and field labels (`block.<type>.name`, `block.<type>.<field>`), editor controls, issue codes (`issue.<code>` for every `PublishIssue.code`), warning codes, Claude panel texts and error codes, diff labels, media, redirects, import, settings and empty states. The admin catalogue is complete in `en`, `nl-BE` and `fr-BE` like every other namespace.

Content seeded by `packages/db/src/seed/site.ts` (development and demo only; BEAM writes real content, proposal section 2): pages `home`, `about`, `day-sessions`, `nights`, `memberships`, `pricing`, `events`, `blog`, `contact`, `privacy`, `terms`, `cookies` with placeholder text in all three locales, the three menus, and the `site` settings defaults. In production the seed creates nothing; content comes from the WordPress import and staff.

## 9. Privacy

`modules/site/privacy.ts` registers:

```ts
export const sitePrivacy = {
  tables: ['terms_acceptances', 'cookie_consents'],
  noPiiTables: ['pages', 'page_versions', 'page_routes', 'redirects', 'nav_menus', 'media_assets', 'page_edit_requests', 'wordpress_imports', 'wordpress_import_items', 'site_audit_reports'],
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
- Erase runs under `SET LOCAL beam.allow_rewrite = 'on'` (both tables are APPEND) before crm anonymises `persons`. `terms_acceptances` is kept and anonymised because it proves which contract terms applied to orders and invoices that Belgian law requires BEAM to keep for 7 years; its `person_id` then points to the anonymised "Deleted person" row and the IP is removed. `cookie_consents` rows are deleted: the visitor's choice lives in their own browser and the log is only evidence while the consent is in force.
- Anonymous visitors: `cookie_consents` rows without `person_id` are found by `consent_key` only and are covered by retention, not by erasure.
- Staff instructions to Claude (`page_edit_requests.instruction`) and AI prompts are content, not customer data; staff are told in the editor "Do not paste customer details". `ai_requests` are deleted after 30 days by platform.
- WordPress import never stores authors, author emails or comments (rule 52 and section 2).
- Testimonials are content published with the quoted person's agreement (rule 21); removing one is a content edit.
- Retention policies seeded into `retention_policies` by the site seed (`on conflict (key) do nothing`), enforced by `privacy.retention_sweep`: `site_cookie_consents` table `cookie_consents`, 395 days, `delete`; `site_terms_acceptances` table `terms_acceptances`, 2,555 days (7 years), `delete`; `site_page_edit_requests` table `page_edit_requests`, 730 days, `delete` (the FK from `page_versions` is `on delete set null`).
- The public website sets no cookie except `beam_consent` (necessary) and, after consent, GA's `_ga` and `_ga_<id>` (analytics). The portal adds Auth.js session cookies (necessary). The cookie notice page lists exactly these; a test asserts the list matches `COOKIE_INVENTORY` in `packages/core/src/site/consent.ts`.

## 10. Dependencies

Needs from other modules (`modules/<m>/api.ts` unless a table is named). Where the owner's spec names a function differently, the owner's name wins and the site package adapts the call; the shape below is what the site needs.

| Module | Capability | Used for |
| --- | --- | --- |
| platform | `action()`, `defineJob`, `requirePermission`, `ctx.audit`, `ctx.enqueue`, `ctx.recordEvent` (Wave 0 `lib/`) | every action and job |
| platform | `createFile(tx, { kind: 'image'\|'import', name, mime, bytes, isPublic }): Promise<{ fileId }>`, route `/api/public/files/[id]` with long-lived cache headers for public images | media library, WXR upload |
| platform | `getSetting(db, key)`, `setSetting(tx, ctx, key, value, expectedVersion)`; keys `site` (new), `company`, `business_hours` | site settings, legal name, contact details, opening hours |
| platform | `runAi(ctx, { feature: 'site.propose_page' \| 'site.seo_audit'; model; system; messages; outputSchema; fieldsSent; maxTokens }): Promise<{ output: unknown; aiRequestId: string }>` (writes `ai_requests`, checks budget, throws `BudgetExceededError`) | Claude-assisted editing |
| platform | portal and admin nav registry generated from `nav.ts` (Wave 0 generator, `audience: 'admin' \| 'portal'`) | portal shell navigation |
| platform | `next.config.ts` wraps the app with Serwist (`swSrc: 'app/sw.ts'`) and keeps CSP allowing `www.googletagmanager.com`, `*.google-analytics.com`, `va.vercel-scripts.com`, `www.youtube-nocookie.com` (frame), `connect.facebook.net` (R3) | PWA and analytics; a missing entry is filed by P1 in `docs/build/dependency-requests.md` |
| crm | `getPersonForPortal(db, personId): Promise<{ firstName, lastName, email, phone, address, locale, birthOn }>`, `updatePersonDetails(tx, ctx, personId, patch)` | account home greeting, profile |
| crm | table `persons` (FK), table `companies` (FK, R3) | acceptances, consents, partner pages |
| booking | `listPublicEvents(db, { from: Date; limit: number; offset: number }): Promise<{ sessionId, title, startsAt, endsAt, status, isMemberOnly, isLeadMagnet, leadWindowEndAt, location, productId, availabilityBand: 'available'\|'few'\|'full' }[]>`; `getAvailability(db, { kind: 'day'\|'night', from, to })` (contract function) for `availability_preview`; `listUpcomingBookingsForPerson(db, personId, limit)`; `listOpenOffersForPerson(db, personId)`; portal routes `/account/book`, `/account/book/[sessionId]`, `/account/waitlist`; table `sessions` (view, FK) | events listing and detail, availability, account home |
| booking (R2) | `listTicketTypesForSession(db, sessionId)` with product ids, `getLeadWindowState(db, sessionId)` | ticket prices and lead-magnet messaging on event pages |
| commerce | `listPublicPrices(db, { productIds?: string[]; at: Date }): Promise<{ productId, sku, kind, name: LocalizedText, publicAmountCents, memberAmountCents: number \| null, vatRatePct, creditUnits, creditKind, validityDays, isActive }[]>`; portal route `/account/shop/[sku]`; it calls `site.getCurrentLegalVersion('terms')` and `site.recordTermsAcceptance()` at checkout | pricing tables, event prices, terms acceptance |
| credits | `getPersonCreditSummary(db, personId): Promise<{ kind, unitsRemaining, nearestExpiresAt }[]>`, `getMembershipSummary(db, personId): Promise<{ status, productName, currentPeriodEndAt, includedCredits } \| null>` | account home |
| forms | `FormEmbed` server component exported from `modules/forms/api.ts` with props `{ slug: string; locale: Locale; context: { pagePath: string; utm?: Record<string,string>; landingPath?: string; referrer?: string; partnerCompanyId?: string } }`; `getPublishedFormMeta(db, slug): Promise<{ formId, locales } \| null>`; seeded forms `contact` (kind lead) and `newsletter` (kind lead, consent purpose `newsletter`) | contact page, footer newsletter, embedded forms, publish checks |
| forms (R3) | `countLandingConversions(db, { from, to }): Promise<{ landingPath, utmCampaign, submissions, newPersons }[]>` | insights |
| commerce (R3) | `countOrdersByLanding(db, { from, to })` from `checkouts.utm` | insights |
| finance | portal route `/account/invoices` | quick action link only |
| webinar (R2) | `WebinarSignup` server component `{ webinarId, locale }`, `listUpcomingRegistrationsForPerson(db, personId)` | webinar landing pages, account home |
| ops | table `retention_policies` (seed rows), `privacy.retention_sweep`, `GDPR_REGISTRY` consumption | retention and privacy |

Provides to other modules:
- commerce, crm, booking: `getCurrentLegalVersion`, `recordTermsAcceptance`, `hasAcceptedCurrentTerms` (checkout, sign-up, POS).
- email: `getLegalLinks(locale)` for the legal footer; `getPageUrl` and `getEventPageUrl` for links in templates.
- automation and email templates: `getEventPageUrl`, `portalUrl`.
- every module with portal pages: the portal shell (layout, header, navigation from their `nav.ts`, terms banner, install prompt) and the PWA service worker.
- forms: the public pages that host their embeds and pass `context` (page path, landing path, UTM, partner).
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
26. A customer changes the preferred locale in the profile: `persons.locale` changes, the response redirects to the same portal page under the new prefix, and later emails use the new locale.
27. Publishing new material terms while a customer is mid-checkout: commerce records acceptance of the version shown at checkout start; the portal banner then asks for the newer version.
28. No published terms in production: `getCurrentLegalVersion('terms')` returns null and `/admin/site` shows the red go-live banner; commerce's checkout refuses to start in production while it is null (commerce spec), and allows it in other environments.
29. Huge page (60 blocks per locale, several FAQs): the 60-block cap keeps documents under 300 KB; `saveDraft` refuses a body over 1 MB with `validation`.
30. Staging or preview deployment indexed by search engines: `robots.txt` disallows everything outside production and every non-production page renders `<meta name="robots" content="noindex, nofollow">` from `buildPageMetadata` (`next.config.ts` is frozen, so no header rule is added).

## 12. Build packages

Order and tracks: P1 first. Then three tracks may run in parallel because they share no file: track A P2 -> P5 -> P6, track B P3 -> P4 -> P7, and nothing else in V1. R2-R4 packages (P8, P9, P10) run after all V1 packages are merged, in that order. Paths below are relative to the repo root; `M` = `apps/web/modules/site`. Every package's done-definition includes: `pnpm gen:indexes && pnpm typecheck && pnpm lint` green, its listed Vitest suites green on `createTestDb()` (PGlite, from schema), `pnpm i18n:check` green, no edits to `package.json`, the lockfile, `packages/db/migrations/`, `registry/*.generated.ts` or frozen files.

### site-P1 (V1): schema, core content model, module skeleton

- Goal: every site table, enum and view; the pure block, path, completeness, diff, consent and JSON-LD logic; the module file skeleton with barrels and stubs so later packages each own separate files; the complete V1 `site` catalogue.
- Files: `packages/db/src/schema/site.ts` (complete the Wave 0 stub, keep existing `pages`/`page_versions` columns), `packages/db/src/schema/site.views.ts`, `packages/db/src/schema/site.test.ts`; `packages/core/src/site/{index,locales,links,rich-text,blocks,paths,completeness,diff,warnings,jsonld,consent,image-size,settings,proposal}.ts` with `*.test.ts` beside `blocks`, `paths`, `completeness`, `diff`, `warnings`, `jsonld`, `consent`, `image-size`; `packages/core/src/i18n/messages/{en,nl-BE,fr-BE}/site.json`; `M/{actions,queries,jobs,api}.ts` (barrels), stubs `M/actions/{pages,nav,redirects,media,settings,proposals,wordpress,portal,partner}.ts`, `M/queries/{public,admin,proposals,portal,wordpress,insights}.ts`, `M/jobs/{publish,propose,wordpress,audit}.ts`, `M/server/{legal,urls,settings}.ts` (exported api functions throwing `NotImplementedError`); `M/{permissions,events,nav,schedules,privacy}.ts`, `M/privacy.test.ts`; append to `docs/build/dependency-requests.md`.
- Interfaces: all core types and functions of section 4 ("Core types"), `ProposalOutput = z.object({ title, paths, blocks: BlocksByLocale, seo, excerpt: LocalizedText.optional(), changeSummary: z.string().max(500) })`, `SiteSettings` Zod with defaults, `COOKIE_INVENTORY`, the api.ts signatures of section 4, `sitePrivacy`.
- Orchestrator requests written to `docs/build/dependency-requests.md`: add `terms_acceptances`, `cookie_consents` (and in R4 `site_audit_reports`) to `APPEND_ONLY_TABLES` and their triggers to a custom migration; npm packages if absent from Wave 0: `@tiptap/react`, `@tiptap/starter-kit`, `@tiptap/extension-link`, `fast-xml-parser`, `node-html-parser`, `@vercel/analytics`, `@axe-core/playwright`; CSP hosts and the Serwist wrapper (section 10).
- Depends on: Wave 0 (`_shared.ts` helpers, stub tables `pages`, `sessions`, `files`, `users`, `persons`, `companies`).
- Tests: `site.test.ts` (tables and views create on PGlite; one-draft partial unique; singleton home; legal key unique; route uniqueness per locale; redirect target check; acceptances idempotency key unique); `blocks.test.ts` (every block type valid and invalid samples, `javascript:` href rejected, hero only first, testimonial without consent rejected, 60-block cap); `paths.test.ts` (normalisation incl. trailing slash, case, `?p=`, reserved segments, 3-segment cap); `completeness.test.ts` (each issue code, per locale, legal-name check, alt text, excerpt for posts); `diff.test.ts` (block pairing by id, inserted, deleted, moved, word diff); `warnings.test.ts` (currency in text, removed blocks, path change); `jsonld.test.ts` (LocalBusiness, Event, BlogPosting, FAQPage, `<` escaped); `consent.test.ts` (encode/decode, expiry 182 days, re-prompt on material version); `image-size.test.ts` (PNG, JPEG, WebP, GIF, AVIF fixtures as byte arrays); `privacy.test.ts` (export lists rows; erase deletes consents, anonymises acceptances; no row keeps the IP).
- Done: common definition.

### site-P2 (V1): public rendering, routing, redirects, metadata

- Goal: every public page renders from the database with all V1 block types, header and footer menus, locale switch, redirects, 404/410, unavailable page, staff preview, RSS, per-page metadata with hreflang and JSON-LD.
- Files: `apps/web/app/[locale]/(site)/{layout.tsx, error.tsx, not-found.tsx, [[...path]]/page.tsx, unavailable/page.tsx, preview/[versionId]/page.tsx, feed.xml/route.ts}` (deletes a Wave 0 `(site)/page.tsx` placeholder if one exists); `M/server/{resolve,render-data,urls,metadata}.ts` (+ `resolve.test.ts`, `urls.test.ts`, `metadata.test.ts`); `M/queries/public.ts`; `M/ui/public/{site-header,site-footer,mobile-menu,locale-switcher,page-view,block-renderer,rich-text,media-image,json-ld,preview-ribbon}.tsx`; `M/ui/public/blocks/{hero,rich-text,image,image-text,cta,card-grid,faq,pricing-table,events-list,availability-preview,posts-list,form-embed,booking-cta,video,testimonial,contact-details,map,legal-meta}.tsx`; `M/ui/public/block-renderer.test.tsx`; `apps/web/e2e/site-public.spec.ts`.
- Interfaces: `resolveRequest(locale, segments, searchParams)`, `getPageByPath`, `getNavMenus`, `listPublicEventsForSite`, `listPosts`, `getPricingRows`, `buildPageMetadata(page, locale): Metadata`; implements `getPageUrl`, `getEventPageUrl`, `portalUrl` in `M/server/urls.ts`.
- Depends on: site-P1; `booking:listPublicEvents`, `booking:getAvailability`, `commerce:listPublicPrices`, `forms:FormEmbed`, `platform:getSetting` (`company`, `business_hours`), `platform:/api/public/files/[id]`. Tests mock the cross-module api functions with `vi.mock`.
- Tests: `resolve.test.ts` (live route; rename redirect to current path; `to_url` redirect; prefix-less legacy lookup; `?p=` lookup on home; archived 410; unpublished 404; other-locale path -> unavailable; redirect hit counter increments); `urls.test.ts` (absolute URLs from `canonicalOrigin`, portal routes, event page fallback to booking URL); `metadata.test.ts` (canonical, hreflang only for live locales, x-default, noindex for past events after 30 days and for non-production); `block-renderer.test.tsx` (one h1 rule, rich text renders no raw HTML, video facade has no iframe before click, testimonial, pricing shows member line, availability bands without numbers, events list empty state).
- e2e `site-public.spec.ts`: home in three locales, `lang` attribute, nav to an offer page, locale switch, pricing table shows seeded prices, events list to event detail to "Get tickets" lands on portal sign-in with `callbackUrl`, legacy WordPress path redirects, 404 and 410 statuses.
- Done: common definition plus the e2e spec green against `beam_dev`.

### site-P3 (V1): back-office CMS, publishing, navigation, media, redirects, settings

- Goal: staff create, edit, preview, publish, schedule, unpublish and archive pages; edit menus, media, redirects and site settings; content issues dashboard.
- Files: `M/actions/{pages,nav,redirects,media,settings}.ts` (+ `pages.test.ts`, `nav.test.ts`, `redirects.test.ts`, `media.test.ts`); `M/server/{versions,publish,refs,cache}.ts` (+ `versions.test.ts`, `publish.test.ts`); implements `M/server/settings.ts`; `M/jobs/publish.ts` (+ `publish.test.ts` in `M/jobs/`); `M/queries/admin.ts`; `M/permissions.test.ts`; `apps/web/app/(admin)/admin/site/{page.tsx, loading.tsx, error.tsx, pages/new/page.tsx, pages/[pageId]/page.tsx, navigation/page.tsx, media/page.tsx, redirects/page.tsx, settings/page.tsx}`; `M/ui/admin/{pages-table,content-issues,page-editor,block-list-editor,block-forms,rich-text-editor,pickers,seo-fields,version-history,nav-editor,media-library,redirects-table,settings-form}.tsx`; `apps/web/e2e/site-admin.spec.ts`.
- Interfaces: `publishVersionTx(tx: Tx, ctx: Ctx, versionId: string, opts: { scheduledBy?: string }): Promise<{ publishedAt: Date }>` (used by the action, the job and P7), `allocateVersion(tx, pageId): Promise<number>`, `assertMutable(row)`, `loadRefFacts(db, refs): Promise<RefFacts>`, `revalidateSite(tags: string[])` (calls `revalidateTag(tag, 'max')`), `getSiteSettings`, `setSiteSettings`.
- Depends on: site-P1; `platform:createFile`, `platform:getSetting/setSetting`, `forms:getPublishedFormMeta`, `commerce:listPublicPrices`, `booking` table `sessions`.
- Tests: `pages.test.ts` (create; save with conflict; one draft; publish blocked with issues per locale; publish writes routes and audit; rename creates redirect and removes a clashing one; schedule bounds; unpublish 404 semantics; archive with redirect; restore copies; published row cannot be updated); `nav.test.ts` (completeness, version conflict, hidden targets reported); `redirects.test.ts` (normalisation, live-path conflict, loop refusal); `media.test.ts` (mime and size refusal, SVG refused, dimensions stored, delete refused when referenced); `jobs/publish.test.ts` (publishes at run time; failed checks clear schedule and audit; double run yields one publish); `permissions.test.ts` (each P3 action refused without `site.edit`/`site.publish`).
- e2e `site-admin.spec.ts`: marketing user logs in with TOTP, creates an offer page in three locales, sees completeness issues, uploads an image with alt text, publishes, opens it on the public site, renames the path and the old path redirects.
- Done: common definition plus e2e green.

### site-P4 (V1): Claude-assisted editing and side-by-side review

- Goal: staff describe a change; `site.propose_page` writes a `proposed` version created by Claude; a reviewer sees the diff and publishes, rejects or copies it into the draft.
- Files: `M/actions/proposals.ts` (+ `proposals.test.ts`), `M/jobs/propose.ts` (+ `propose.test.ts`), `M/server/{ai-prompt,proposal-validate}.ts` (+ `ai-prompt.test.ts`), `M/queries/proposals.ts`, `apps/web/app/(admin)/admin/site/pages/[pageId]/versions/[versionId]/page.tsx`, `M/ui/admin/{claude-panel,version-diff,diff-text,preview-frames}.tsx`; edits `M/ui/admin/page-editor.tsx` to mount the Claude panel (strictly after site-P3, which created it); `apps/web/e2e/site-claude.spec.ts`.
- Interfaces: `buildProposalPrompt(input: { page, base, instruction, locales, refs, brandVoice }): { system: string; messages: AiMessage[]; fieldsSent: string[] }`, `validateProposal(base, output, page): { ok: true; content } | { ok: false; errors: string[] }`.
- Depends on: site-P3 (`allocateVersion`, `publishVersionTx`, editor); `platform:runAi` and `anthropic/fake.ts`.
- Tests: `propose.test.ts` (fake returns valid output -> proposed version with `created_by = 'claude'`, `edit_request_id`, `based_on_version_id`; invalid then valid -> one repair; invalid twice -> `failed`/`invalid_output`, no version; budget -> `budget_exceeded`; retryable error then success; double run -> one version; kind change or dropped locale rejected); `proposals.test.ts` (requires `ai.use`; one active request per page; cancel only pending; reject sets reason; copy to draft respects `replaceExisting`; publishing a proposal requires `site.publish`); `ai-prompt.test.ts` (no email, phone or person names from the database in the prompt; `fieldsSent` exact; reference lists capped at 200 items).
- e2e `site-claude.spec.ts` (fake Claude): ask for an FAQ, wait for proposal, see inserted block highlighted in the diff, publish, public page shows the FAQ.
- Done: common definition plus e2e green.

### site-P5 (V1): SEO files, cookie consent and analytics, legal and terms, PWA

- Goal: sitemap, robots, manifest, icons, service worker and offline page; cookie banner with logged choices and consent-gated Vercel Analytics and GA4; legal API (current versions, terms acceptance) for other modules.
- Files: `apps/web/app/{sitemap.ts, robots.ts, manifest.ts, sw.ts}`, `apps/web/app/pwa-icon/[size]/route.tsx`, `apps/web/app/[locale]/(site)/offline/page.tsx`, `apps/web/app/api/public/cookie-consent/route.ts` (+ `route.test.ts`); implements `M/server/legal.ts` (+ `legal.test.ts`); `M/server/{sitemap,consent}.ts` (+ `sitemap.test.ts`); `M/ui/public/{consent-provider,cookie-banner,cookie-settings-dialog,analytics-loader,utm-capture,sw-register}.tsx`; edits `apps/web/app/[locale]/(site)/layout.tsx` to mount them (strictly after site-P2, which created it); `apps/web/e2e/{site-consent,site-a11y}.spec.ts`.
- Interfaces: `getCurrentLegalVersion`, `recordTermsAcceptance`, `hasAcceptedCurrentTerms`, `getLegalLinks` (section 4), `recordCookieConsent(db, input): Promise<{ consentKey }>`, `getSitemapEntries(): Promise<MetadataRoute.Sitemap>`, `<ConsentProvider>` with `useConsent(): { analytics: boolean; marketing: boolean; open(): void }`.
- Depends on: site-P2 (layout, urls); `platform:recordEvent` for `site.terms_accepted`.
- Tests: `legal.test.ts` (null when unpublished; ordinal from `v_legal_versions`; acceptance idempotent; event written once; material change makes `hasAcceptedCurrentTerms` false; non-material keeps it true); `sitemap.test.ts` (live routes with alternates, excludes noindex, archived, past events after 30 days; robots per environment); `route.test.ts` (valid body inserts row and sets cookie attributes; person linked when a customer session exists; invalid body 400; ip stored only as HMAC).
- e2e `site-consent.spec.ts`: no request to `googletagmanager.com` or `va.vercel-scripts.com` before consent; reject-all keeps it so; accept loads both (production-mode flag set in the test env); withdraw from footer removes `_ga` cookies; banner buttons have equal size. `site-a11y.spec.ts`: axe (`wcag2a`, `wcag2aa`, `wcag21aa`) with zero serious or critical violations on home, offer, pricing, events, event detail, contact, legal, 404; keyboard-only path through menu and banner.
- Done: common definition plus both e2e specs green; manifest passes Chrome installability (checked in e2e via `page.evaluate` of the manifest and service-worker registration).

### site-P6 (V1): portal shell, account home, profile

- Goal: the customer portal frame every module's portal pages render in, the account home and the profile page, the terms banner and the install prompt.
- Files: edits `apps/web/app/[locale]/(portal)/account/layout.tsx` (Wave 0 shell; owned by site from here); creates `apps/web/app/[locale]/(portal)/account/{page.tsx, loading.tsx, error.tsx, profile/page.tsx}`; `M/actions/portal.ts` (+ `portal.test.ts`), `M/queries/portal.ts` (+ `portal.test.ts` in `M/queries/`); `M/ui/portal/{portal-header,portal-nav,account-home,terms-banner,install-prompt,profile-form}.tsx`, `M/ui/portal/cards/{bookings-card,balance-card,membership-card,offers-card,quick-actions}.tsx`; `apps/web/e2e/site-portal.spec.ts`.
- Interfaces: `getAccountHome(personId, locale): Promise<{ firstName; bookings: Result<UpcomingBooking[]>; balances: Result<CreditSummary[]>; membership: Result<MembershipSummary | null>; offers: Result<WaitlistOffer[]> }>` where `Result<T> = { ok: true; data: T } | { ok: false }` (one failing module never fails the page), `acceptCurrentTerms`, `updateMyProfile`.
- Depends on: site-P5 (`hasAcceptedCurrentTerms`, `recordTermsAcceptance`, consent components, `sw-register`); `crm:getPersonForPortal`, `crm:updatePersonDetails`, `booking:listUpcomingBookingsForPerson`, `booking:listOpenOffersForPerson`, `credits:getPersonCreditSummary`, `credits:getMembershipSummary`, platform portal nav registry.
- Tests: `queries/portal.test.ts` (only the actor's data; guest bookings made by the person included; a throwing credits api yields `{ ok: false }` for that card only); `actions/portal.test.ts` (accept terms writes one acceptance with context `portal_prompt`; second call is a no-op; staff and anonymous refused; profile update passes the patch to crm; locale change returns `redirectTo` with the new prefix; email cannot be changed).
- e2e `site-portal.spec.ts`: customer signs in by magic link (email sink), sees account home with a seeded booking and balance, follows Book a day session, edits phone in profile, sees and accepts the terms banner after a material terms publish; axe zero serious or critical violations on account home and profile.
- Done: common definition plus e2e green.

### site-P7 (V1): WordPress migration and seed content

- Goal: upload a WXR export, map items to pages and posts with locales and translation groups, fetch media, create draft pages and redirects from every old URL, publish complete imported pages in bulk; development seed content.
- Files: `packages/integrations/src/wordpress/{client.ts, fake.ts, index.ts, client.test.ts}`; `M/server/wordpress/{wxr,convert,apply}.ts` (+ `wxr.test.ts`, `convert.test.ts`, `apply.test.ts`), `M/server/wordpress/__fixtures__/beam-sample.wxr.xml` (10 pages in nl and fr with WPML groups, 4 posts, 6 attachments, shortcodes, Gutenberg comments, one comment and one author that must not be stored); `M/actions/wordpress.ts`, `M/jobs/wordpress.ts` (+ `wordpress.test.ts` in `M/jobs/`), `M/queries/wordpress.ts`; `apps/web/app/(admin)/admin/site/imports/{page.tsx, [importId]/page.tsx}`; `M/ui/admin/{imports-table,import-mapping,redirect-coverage}.tsx`; `packages/db/src/seed/site.ts`, `M/seed.ts`.
- Interfaces: `parseWxr(xml: string): { items: WxrItem[]; errors: { line: number; message: string }[] }`, `htmlToBlocks(html: string, ctx: { mediaByUrl: Map<string,string> }): { blocks: Block[]; report: ConvertReport }`, `applyImportChunk(tx, ctx, importId, offset, limit = 50): Promise<{ next: number | null }>`, `WordpressMediaClient` (section 6).
- Depends on: site-P3 (`allocateVersion`, `publishVersionTx`); `platform:createFile` (P7 inserts `files` and `media_assets` itself and does not import `actions/media.ts`); npm `fast-xml-parser`, `node-html-parser` (requested by P1).
- Tests: `wxr.test.ts` (fixture parse counts; authors and comments absent; translation groups; drafts default to skip; malformed XML reports a line); `convert.test.ts` (headings h1 -> h2, lists, links, bold and italic, `img` -> image block, YouTube iframe -> video, shortcodes stripped and reported, inline styles dropped, empty paragraphs removed); `apply.test.ts` (WPML group becomes one page with two locales; redirects for each old path and attachment URL; `redirect_only` items; rerun creates nothing new); `jobs/wordpress.test.ts` (parse, media and apply jobs each run twice -> same state; 404 media marks the item error and continues); `client.test.ts` (refuses other origins, size cap, mime check, logs integration calls).
- e2e: none (covered by integration tests; the real import is a rehearsal in week 7 on `staging`).
- Done: common definition.

### site-P8 (R2): events and ticketing extensions, webinar landing, R2 portal cards

- Goal: event detail pages show ticket types with public and member prices, lead-magnet messaging and sold-out waitlist entry; `webinar_signup` block renders the webinar module's registration; account home shows upcoming webinars and an "Invite a guest" card.
- Files: `M/ui/public/blocks/{events-list.tsx (edit), webinar-signup.tsx}`, `M/ui/public/event-facts.tsx`, `M/server/render-data.ts` (edit), `M/queries/public.ts` (edit), `M/queries/portal.ts` (edit), `M/ui/portal/account-home.tsx` (edit), `M/ui/portal/cards/{webinars-card,guests-card}.tsx`, `packages/core/src/i18n/messages/*/site.json` (edit), tests `M/ui/public/event-facts.test.tsx`, `apps/web/e2e/site-events-r2.spec.ts`. Strictly after all V1 packages.
- Depends on: site-P2, site-P6; `booking:listTicketTypesForSession`, `booking:getLeadWindowState`, `commerce:listPublicPrices`, `webinar:WebinarSignup`, `webinar:listUpcomingRegistrationsForPerson`.
- Tests: ticket prices per type with member line; lead window open shows "Priority access for new guests until <date, Europe/Brussels>" and never a count or rank; full event shows waitlist entry; webinar card scoped to the person.
- Done: common definition plus e2e green.

### site-P9 (R3): marketing tags, partner landing pages, landing insights

- Goal: marketing consent activates Google Ads conversion and Meta Pixel; landing pages linked to a partner company pass the partner to forms; insights screen per landing page and campaign.
- Files: `packages/db/src/schema/site.ts` (edit: add `pages.partner_company_id` and its check, an expand step), `packages/core/src/site/settings.ts` (edit: ad ids), `M/actions/partner.ts` (`setPagePartner`, `site.publish`, audit `site.page.set_partner`), `M/ui/public/analytics-loader.tsx` and `cookie-settings-dialog.tsx` (edit), `M/ui/public/blocks/form-embed.tsx` (edit: partner context), `M/queries/insights.ts`, `apps/web/app/(admin)/admin/site/insights/page.tsx`, `M/ui/admin/page-editor.tsx` (edit: partner picker for landing pages), i18n `site.json` (edit), tests `M/actions/partner.test.ts`, `M/queries/insights.test.ts`, `apps/web/e2e/site-consent.spec.ts` (edit: marketing cases). Strictly after site-P8.
- Depends on: site-P5, site-P3; `crm` table `companies`; `forms:countLandingConversions`; `commerce:countOrdersByLanding`.
- Tests: no marketing tag without marketing consent; partner id passed only for `landing` pages; insights totals match fixtures; permission `reports.read` required.
- Done: common definition plus e2e green.

### site-P10 (R4): Claude translations and weekly content audit

- Goal: "Translate missing locales" creates a `translate` edit request whose proposal fills the missing locales of a page; a weekly Claude audit writes `site_audit_reports` shown on `/admin/site`.
- Files: `packages/db/src/schema/site.ts` (edit: `site_audit_reports`), `M/actions/proposals.ts` (edit: `kind: 'translate'`), `M/jobs/propose.ts` and `M/server/ai-prompt.ts` (edit), `M/jobs/audit.ts`, `M/schedules.ts` (edit: `site.seo_audit` `10 7 * * 1`), `M/ui/admin/{claude-panel,content-issues}.tsx` (edit), i18n `site.json` (edit), tests `M/jobs/audit.test.ts`, `M/jobs/propose.test.ts` (edit: translate cases). Strictly after site-P9.
- Depends on: site-P4; `platform:runAi` with `claude-haiku-5-5`.
- Tests: translation proposal keeps block ids and structure of the source locale and only adds target locales; audit double run inserts one report per week; findings never include personal data; budget exhaustion leaves no report and no failure loop.
- Done: common definition.

## 13. Decisions made

Additions to the architecture (tables, columns, settings, routes, providers):
1. Tables added beside the architecture's `pages` and `page_versions`: `page_routes`, `redirects`, `nav_menus`, `media_assets`, `page_edit_requests`, `terms_acceptances` (APPEND), `cookie_consents` (APPEND), `wordpress_imports`, `wordpress_import_items`, and in R4 `site_audit_reports` (APPEND). Each answers a stated requirement: localised URLs, WordPress redirects, navigation, alt text (WCAG), Claude request tracking, terms versioning evidence, cookie consent evidence, migration.
2. Columns added to `pages`: `kind`, `legal_key`, `session_id`, `partner_company_id` (R3), `first_published_at`, `archived_at`, `archived_by_user_id`, `created_by_user_id`. Columns added to `page_versions`: `state`, `title`, `paths`, `excerpt`, `cover_media_id`, `is_material_change`, `change_summary`, `based_on_version_id`, `created_by_user_id`, `edit_request_id`, `scheduled_publish_at`, `published_by_user_id`, `rejected_at`, `rejected_by_user_id`, `reject_reason`, `updated_at`. `page_versions.seo` and `blocks` keep the architecture's "per locale" shape.
3. `page_versions` is IMMUTABLE only once published: a `draft` row is edited in place (one draft per page), a `proposed` row only changes state. This reads the architecture's IMMUTABLE rule literally ("a published version row is never edited").
4. `proposed_by_ai_request_id` has no foreign key, because `ai_requests` is purged after 30 days; the durable link is `edit_request_id`.
5. New `settings` key `site` (`SiteSettings`, section 4) next to the architecture's keys.
6. New public route `POST /api/public/cookie-consent` besides the architecture's `api/public/*` list; new metadata routes `sitemap.ts`, `robots.ts`, `manifest.ts`, `app/pwa-icon/[size]`; new site routes `preview/[versionId]`, `unavailable`, `offline`, `feed.xml`.
7. New integration client `packages/integrations/src/wordpress/` (provider `wordpress` in `integration_calls`) used only during migration.
8. New job kinds `site.propose_page` (named in the architecture), `site.publish_version`, `site.wp_parse`, `site.wp_fetch_media`, `site.wp_apply`, and in R4 `site.seo_audit` with schedule Monday 07:10. New activity event kind `site.terms_accepted`. No new permission strings.
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
19. Caching: public data through `unstable_cache` with tags (`site:page:<id>`, `site:routes`, `site:nav`, `site:sitemap`, `site:events`, `site:prices`); page routes `revalidate = 3600`; prices and events at most 300 s old; publish revalidates with `revalidateTag(tag, 'max')`.
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
28. Cookie categories `necessary`, `analytics`, `marketing`; consent cookie `beam_consent` for 182 days; consent log rows kept 395 days; GA4 loaded only after consent (basic consent mode, no cookieless pings), only on public pages in production; Vercel Analytics also waits for consent, on site and portal; nothing on admin.
29. UTM and landing path persist across pages (sessionStorage) only after analytics consent.
30. IPs in cookie consent logs are stored only as an HMAC with `AUTH_SECRET`; terms acceptances keep the plain IP as contract evidence, removed on erasure.
31. On erasure `terms_acceptances` are anonymised and kept (7-year retention with the invoices), `cookie_consents` deleted. Retention: consents 395 days, acceptances 2,555 days, Claude edit requests 730 days, all `delete`.

Portal, PWA, quality:
32. The site owns the portal layout, account home and profile; other modules' portal pages plug in through their `nav.ts` portal entries, and account home reads their `api.ts` functions; each card fails independently.
33. Profile editing goes through crm; the login email cannot be changed in the portal.
34. One service worker at scope `/` for site and portal (Serwist), network-first navigations, no offline writes, never handling `/admin` or `/api`; manifest `start_url` `/account?source=pwa`; icons generated with `ImageResponse` until BEAM supplies brand files.
35. Accessibility gate: axe with zero serious or critical violations on every V1 page template in Playwright; budgets LCP 2.5 s, CLS 0.1, INP 200 ms, 120 KB first-load JS.
36. No site search, no personalised public pages, no A/B tests (Later).

Migration and build:
37. WordPress content comes from a WXR export file (no live WordPress API); WPML or Polylang translation groups become one multi-locale page; imported pages arrive as drafts and are published by staff, in bulk when complete; authors and comments are never imported.
38. Old URLs are covered by redirects for every page, post and attachment, with a coverage list; the real import is rehearsed on `staging` in week 7 before the DNS switch in week 8.
39. Module files are split into area files behind barrels (`actions.ts`, `queries.ts`, `jobs.ts`, `api.ts`) created by P1, so parallel packages never share a file; P1 writes the complete V1 `site` catalogue; e2e specs are split per area (`site-public`, `site-admin`, `site-claude`, `site-consent`, `site-a11y`, `site-portal`, `site-events-r2`).
40. Seed content is development and demo only; production content comes from the import and BEAM staff.
