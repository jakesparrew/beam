create or replace view v_legal_versions as
select p.legal_key, v.id as version_id, v.published_at, v.is_material_change,
       row_number() over (partition by p.legal_key order by v.published_at) as ordinal,
       (v.id = p.current_version_id) as is_current
from pages p join page_versions v on v.page_id = p.id
where p.legal_key is not null and v.published_at is not null;
--> statement-breakpoint
create or replace view v_published_pages as
select p.id as page_id, p.kind, p.slug, p.legal_key, p.session_id, p.partner_company_id, p.first_published_at,
       v.id as version_id, v.version, v.title, v.locales, v.seo, v.excerpt, v.cover_media_id, v.published_at, v.is_material_change
from pages p join page_versions v on v.id = p.current_version_id
where p.status = 'published';
--> statement-breakpoint
create or replace view v_site_events as
select s.id as session_id, s.title as session_title, s.starts_at, s.ends_at, s.status as session_status,
       s.is_member_only, s.is_lead_magnet, s.lead_window_end_at, s.location,
       p.id as page_id, v.id as version_id, v.locales, v.title as page_title, v.excerpt, v.cover_media_id
from sessions s
left join pages p on p.session_id = s.id and p.status = 'published'
left join page_versions v on v.id = p.current_version_id
where s.kind = 'event' and s.status <> 'cancelled';
--> statement-breakpoint
create or replace view v_site_page_overview as
select p.id as page_id, p.kind, p.slug, p.status, p.current_version_id,
       (select v.id from page_versions v where v.page_id = p.id and v.state = 'draft') as draft_version_id,
       (select count(*) from page_versions v where v.page_id = p.id and v.state = 'proposed')::int as open_proposals,
       (select max(v.published_at) from page_versions v where v.page_id = p.id) as last_published_at,
       p.updated_at
from pages p;
--> statement-breakpoint
create or replace view v_terms_acceptance_latest as
select distinct on (person_id, legal_key) person_id, legal_key, page_version_id, accepted_at, context
from terms_acceptances order by person_id, legal_key, accepted_at desc;
