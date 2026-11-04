/**
 * site's GDPR registration (site spec section 9, architecture section 11). Facade read by
 * `pnpm gen:indexes`; ops runs export, erase and the retention sweeps.
 *
 * Person data lives in `terms_acceptances` (person_id, ip) and `cookie_consents` (person_id,
 * ip_hash). Both are APPEND and crm's merge never moves them, so export and erase run over every id
 * of `crm.resolvePersonIds(personId)`. Erase runs under `SET LOCAL beam.allow_rewrite = 'on'`:
 * acceptances are kept (they prove which terms applied to orders and invoices for 10 years) with
 * the IP removed; cookie consents are deleted.
 */
import type { Tx } from "@beam/db";
import { cookieConsents, termsAcceptances } from "@beam/db/schema";
import type { EraseReportRow, PrivacyRegistration, RetentionPolicySeed } from "@beam/core/privacy";
import { resolvePersonIds } from "@/modules/crm/api";
import { inArray, lt, sql, type DbOrTx } from "@/lib/ctx";
import { rowsOf } from "@/lib/sensitive";

const allowRewrite = (tx: DbOrTx) => tx.execute(sql`set local beam.allow_rewrite = 'on'`);

async function personIds(tx: Tx, personId: string): Promise<string[]> {
  const ids = await resolvePersonIds(tx, personId);
  return [...new Set([personId, ...ids])];
}

async function exportPerson(tx: Tx, personId: string): Promise<Record<string, unknown>> {
  const ids = await personIds(tx, personId);
  const list = sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const acceptances = rowsOf(
    await tx.execute(sql`
      select ta.legal_key::text as legal_key, lv.ordinal::int as version_ordinal, ta.accepted_at, ta.context::text as context,
             ta.ref_type, ta.ref_id, ta.ip
      from terms_acceptances ta
      left join v_legal_versions lv on lv.version_id = ta.page_version_id
      where ta.person_id in (${list})
      order by ta.accepted_at`),
  );
  const consents = rowsOf(
    await tx.execute(sql`
      select recorded_at, action::text as action, choices, banner_version, locale::text as locale
      from cookie_consents where person_id in (${list})
      order by recorded_at`),
  );
  return { "site/terms_acceptances.json": acceptances, "site/cookie_consents.json": consents };
}

async function erasePerson(tx: Tx, personId: string): Promise<EraseReportRow[]> {
  const ids = await personIds(tx, personId);
  await allowRewrite(tx);
  const anonymised = await tx
    .update(termsAcceptances)
    .set({ ip: null })
    .where(inArray(termsAcceptances.personId, ids))
    .returning({ id: termsAcceptances.id });
  const deleted = await tx.delete(cookieConsents).where(inArray(cookieConsents.personId, ids)).returning({ id: cookieConsents.id });
  return [
    { table: "terms_acceptances", rows: anonymised.length, action: "anonymised" },
    { table: "cookie_consents", rows: deleted.length, action: "deleted" },
  ];
}

/** Rows of ops' `retention_policies`, seeded with `on conflict (key) do nothing` (section 9). */
export const retention: readonly RetentionPolicySeed[] = [
  { key: "site.cookie_consents", tableName: "cookie_consents", days: 395, action: "delete", description: "Cookie consent log after 395 days" },
  { key: "site.terms_acceptances", tableName: "terms_acceptances", days: 3653, action: "delete", description: "Terms acceptances after 10 years (accounting horizon)" },
  { key: "site.page_edit_requests", tableName: "page_edit_requests", days: 730, action: "delete", description: "Claude page edit requests after 2 years" },
];

const sweepCount = async (q: Promise<{ id: string }[]>) => (await q).length;

export const privacy: PrivacyRegistration<Tx> = {
  tables: ["terms_acceptances", "cookie_consents"],
  export: exportPerson,
  erase: erasePerson,
  sweep: {
    "site.cookie_consents": async (tx, cutoff) => {
      await allowRewrite(tx);
      return sweepCount(tx.delete(cookieConsents).where(lt(cookieConsents.recordedAt, cutoff)).returning({ id: cookieConsents.id }));
    },
    "site.terms_acceptances": async (tx, cutoff) => {
      await allowRewrite(tx);
      return sweepCount(tx.delete(termsAcceptances).where(lt(termsAcceptances.acceptedAt, cutoff)).returning({ id: termsAcceptances.id }));
    },
    "site.page_edit_requests": async (tx, cutoff) =>
      rowsOf(await tx.execute(sql`delete from page_edit_requests where created_at < ${cutoff.toISOString()}::timestamptz and status not in ('pending', 'running') returning id`)).length,
  },
  retention,
};

/** The spec's name for the registration (section 9). */
export const sitePrivacy = privacy;

/** Site tables without person data (listed in platform's `NO_PII_TABLES`). */
export const noPiiTables = [
  "pages",
  "page_versions",
  "page_routes",
  "redirects",
  "nav_menus",
  "media_assets",
  "page_edit_requests",
  "wordpress_imports",
  "wordpress_import_items",
  "site_audit_reports",
];
