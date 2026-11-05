/**
 * A published event page of a spec's own, for specs that need an event detail page when the demo
 * seed of beam_dev has none (site-a11y, site-perf): a published, open event session about ten days
 * ahead and an event page for it at `/<prefix>/<slug>` in every locale, with a short text block.
 * `removeEventPage` archives the page (without routes) and cancels the session again.
 */
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { e2eRows } from "./db";

const DAY = 86_400_000;
const json = (v: unknown) => JSON.stringify(v);
const doc = (text: string) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });

export type E2eEventPage = { slug: string; pageId: string; sessionId: string; nlPath: string };

export async function createEventPage(prefix: string): Promise<E2eEventPage> {
  const tag = randomUUID().slice(0, 8);
  const slug = `${prefix}-${tag}`;
  const title = { "nl-BE": `E2E lezing ${tag}`, "fr-BE": `E2E conférence ${tag}`, en: `E2E lecture ${tag}` };
  const startsAt = new Date(Date.now() + 10.4 * DAY);
  const endsAt = new Date(startsAt.getTime() + 2 * 60 * 60 * 1000);
  const [session] = await e2eRows<{ id: string }>(sql`
    insert into sessions (kind, title, starts_at, ends_at, capacity_seats, event_category, published_at)
    values ('event', ${json(title)}::jsonb, ${startsAt}, ${endsAt}, 30, 'lecture', now() - interval '1 day')
    returning id`);
  const [page] = await e2eRows<{ id: string }>(sql`insert into pages (kind, slug, session_id) values ('event', ${slug}, ${session!.id}) returning id`);
  const paths = { "nl-BE": slug, "fr-BE": slug, en: slug };
  const blocks = {
    "nl-BE": [{ id: randomUUID(), type: "rich_text", doc: doc("Een avond over herstel, slaap en ademhaling.") }],
    "fr-BE": [{ id: randomUUID(), type: "rich_text", doc: doc("Une soirée sur la récupération, le sommeil et la respiration.") }],
    en: [{ id: randomUUID(), type: "rich_text", doc: doc("An evening about recovery, sleep and breathing.") }],
  };
  const seo = Object.fromEntries(Object.entries(title).map(([l, t]) => [l, { title: `${t} | BEAM`, description: `${t}: an evening about recovery, sleep and breathing at BEAM Vitality Center.` }]));
  const [version] = await e2eRows<{ id: string }>(sql`
    insert into page_versions (page_id, version, state, title, paths, blocks, seo, locales, published_at)
    values (${page!.id}, 1, 'published', ${json(title)}::jsonb, ${json(paths)}::jsonb, ${json(blocks)}::jsonb, ${json(seo)}::jsonb, '{nl-BE,fr-BE,en}', now())
    returning id`);
  await e2eRows(sql`update pages set status = 'published', current_version_id = ${version!.id}, first_published_at = now() where id = ${page!.id}`);
  for (const locale of ["nl-BE", "fr-BE", "en"]) {
    await e2eRows(sql`insert into page_routes (page_id, locale, path, version_id) values (${page!.id}, ${locale}, ${slug}, ${version!.id})`);
  }
  return { slug, pageId: page!.id, sessionId: session!.id, nlPath: `/nl/${slug}` };
}

export async function removeEventPage(made: E2eEventPage | null): Promise<void> {
  if (!made) return;
  await e2eRows(sql`delete from page_routes where page_id = ${made.pageId}`);
  await e2eRows(sql`update pages set status = 'archived', archived_at = now(), session_id = null where id = ${made.pageId}`);
  await e2eRows(sql`update sessions set status = 'cancelled', cancelled_at = now(), cancel_reason = 'e2e event page cleanup' where id = ${made.sessionId} and status <> 'cancelled'`);
}
