/**
 * crm's demo seed (runbook 6.3, crm-P1). Facade read by `pnpm gen:indexes`; runs after platform.
 *
 * - Backfills `email_hash` and `phone_e164` on persons that lack them (platform's demo persons
 *   are inserted directly).
 * - 40 test persons `crm-demo-<n>@example.com` (Belgian names, three locales, varied
 *   acquisition sources, a few with phones, addresses and birth dates, one minor), with system
 *   tags on some of them.
 * - 5 companies (one partner) with contacts.
 * - 10 tasks owned by the demo staff users (skipped when no staff user exists).
 *
 * Inserted directly (crm's api lands with crm-P2); idempotent: persons by address, companies by
 * VAT number, tasks by `dedupe_key`, tags and contacts on their unique keys. Ids are recorded as
 * `crm.person.demo<n>`, `crm.company.<slug>`.
 */
import type { DbOrTx } from "@beam/db";
import { companies, companyContacts, persons, personTags, tags, tasks, users, type AcquisitionJson, type PostalAddressJson } from "@beam/db/schema";
import { emailHash, normalisePhone, type AcquisitionSource } from "@beam/core/crm";
import type { Locale } from "@beam/core/i18n";
import { and, eq, isNull, sql } from "@/lib/ctx";
import { rowsOf } from "@/lib/sensitive";
import type { SeedCtx } from "@/scripts/seed-demo";

const SYSTEM = { kind: "system", id: null } as const;
const DAY = 24 * 60 * 60 * 1000;

const FIRST: Record<Locale, string[]> = {
  "nl-BE": ["Lotte", "Wout", "Femke", "Jens", "Nele", "Arne", "Lien", "Pieter", "Hanne", "Bram", "Sien", "Tibo", "Ine", "Kobe", "Marthe", "Ruben", "Elien", "Jasper"],
  "fr-BE": ["Camille", "Antoine", "Manon", "Hugo", "Chloé", "Louis", "Léa", "Maxime", "Pauline", "Thomas", "Juliette", "Nicolas", "Elise", "Romain"],
  en: ["Emma", "Oliver", "Grace", "Liam", "Sophie", "Noah", "Amelia", "Ethan"],
};
const LAST: Record<Locale, string[]> = {
  "nl-BE": ["Peeters", "Janssens", "Maes", "Jacobs", "Mertens", "Willems", "Claes", "Goossens", "Wouters", "De Smet", "Dubois", "Lambrechts", "Hermans", "Aerts", "Van den Broeck", "Verhoeven", "Michiels", "Desmet"],
  "fr-BE": ["Dupont", "Lambert", "Martin", "Leroy", "Lemaire", "Simon", "Laurent", "Renard", "Collard", "Gilson", "Lejeune", "Henrard", "Mathieu", "Dumont"],
  en: ["Smith", "Taylor", "Brown", "Wilson", "Evans", "Walker", "Wright", "Hughes"],
};
const CITIES: readonly { postal_code: string; city: string }[] = [
  { postal_code: "9000", city: "Gent" },
  { postal_code: "2000", city: "Antwerpen" },
  { postal_code: "1000", city: "Brussel" },
  { postal_code: "8000", city: "Brugge" },
  { postal_code: "3000", city: "Leuven" },
  { postal_code: "4000", city: "Liège" },
  { postal_code: "5000", city: "Namur" },
];
const SOURCES: readonly AcquisitionSource[] = ["website", "landing_page", "paid_meta", "organic_search", "social_media", "webinar", "event", "referral", "walk_in", "import", "manual", "qr_code"];

export type DemoPerson = {
  n: number;
  email: string;
  firstName: string;
  lastName: string;
  locale: Locale;
  phone: string | null;
  address: PostalAddressJson | null;
  birthOn: string | null;
  acquisition: AcquisitionJson;
  createdDaysAgo: number;
  tags: string[];
};

/** The 40 demo persons: 18 `nl-BE`, 14 `fr-BE`, 8 `en`; deterministic, no PRNG needed. */
export function demoPersons(): DemoPerson[] {
  const out: DemoPerson[] = [];
  const plan: [Locale, number][] = [
    ["nl-BE", 18],
    ["fr-BE", 14],
    ["en", 8],
  ];
  let n = 0;
  for (const [locale, count] of plan) {
    for (let i = 0; i < count; i++) {
      n++;
      const place = CITIES[n % CITIES.length]!;
      const source = SOURCES[n % SOURCES.length]!;
      out.push({
        n,
        email: `crm-demo-${n}@example.com`,
        firstName: FIRST[locale][i]!,
        lastName: LAST[locale][i]!,
        locale,
        phone: n % 3 === 0 ? `0470 ${String(10 + n).padStart(2, "0")} ${String(20 + n).padStart(2, "0")} ${String(30 + n).padStart(2, "0")}` : null,
        address: n % 2 === 0 ? { street: "Demostraat", number: String(n), postal_code: place.postal_code, city: place.city, country: "BE" } : null,
        // One minor (n = 7) for the guardian-consent flow; a few adults with a birth date.
        birthOn: n === 7 ? "2014-06-15" : n % 5 === 0 ? `${1970 + n}-0${(n % 9) + 1}-1${n % 9}` : null,
        acquisition: { source, ...(source === "paid_meta" ? { campaign: "spring-sleep", medium: "cpc" } : {}), captured_at: "2026-01-01T00:00:00.000Z" },
        createdDaysAgo: 3 + n * 9,
        tags: [...(n % 10 === 1 ? ["vip"] : []), ...(n % 4 === 0 ? ["interest:sleep"] : []), ...(n % 6 === 0 ? ["interest:breathwork"] : []), ...(n % 7 === 0 ? ["interest:events"] : [])],
      });
    }
  }
  return out;
}

export const DEMO_COMPANIES = [
  { slug: "zorgpunt", name: "Zorgpunt Gent BV", vatNumber: "BE0400000101", industry: "Healthcare", size: "50_249", status: "customer", isPartner: false, contacts: [2, 3] },
  { slug: "atelier-lumiere", name: "Atelier Lumière SRL", vatNumber: "BE0400000202", industry: "Design", size: "10_49", status: "prospect", isPartner: false, contacts: [20] },
  { slug: "brightops", name: "BrightOps NV", vatNumber: "BE0400000303", industry: "Software", size: "250_plus", status: "target", isPartner: false, contacts: [33] },
  { slug: "kine-plus", name: "Kine Plus", vatNumber: "BE0400000404", industry: "Physiotherapy", size: "1_9", status: "partner", isPartner: true, contacts: [5] },
  { slug: "hotel-de-linde", name: "Hotel De Linde", vatNumber: "BE0400000505", industry: "Hospitality", size: "10_49", status: "inactive", isPartner: false, contacts: [] },
] as const;

const DEMO_TASKS: readonly { title: string; kind: (typeof tasks.$inferInsert)["kind"]; role: string; person?: number; company?: string; dueInDays: number; priority: "low" | "normal" | "high" }[] = [
  { title: "Call back about the 10-session package", kind: "call", role: "customer_service", person: 1, dueInDays: -2, priority: "high" },
  { title: "Follow up after the first visit", kind: "follow_up", role: "customer_service", person: 4, dueInDays: 0, priority: "normal" },
  { title: "Check open payment", kind: "payment", role: "finance", person: 9, dueInDays: 3, priority: "normal" },
  { title: "Send a team-day proposal", kind: "proposal", role: "sales", company: "atelier-lumiere", dueInDays: 5, priority: "high" },
  { title: "Prepare the partner review", kind: "review", role: "sales", company: "kine-plus", dueInDays: 10, priority: "low" },
  { title: "Introduce BEAM to the HR lead", kind: "call", role: "sales", company: "brightops", dueInDays: -1, priority: "normal" },
  { title: "Ask for feedback on the night stay", kind: "follow_up", role: "reception", person: 12, dueInDays: 1, priority: "low" },
  { title: "Reactivation call", kind: "call", role: "customer_service", person: 25, dueInDays: 7, priority: "normal" },
  { title: "Confirm guardian consent at reception", kind: "other", role: "reception", person: 7, dueInDays: 0, priority: "high" },
  { title: "Renewal talk with Zorgpunt", kind: "proposal", role: "management", company: "zorgpunt", dueInDays: 14, priority: "normal" },
];

async function backfillIdentity(db: DbOrTx): Promise<number> {
  const rows = rowsOf<{ id: string; email: string | null; phone: string | null; email_hash: string | null; phone_e164: string | null }>(
    await db.execute(sql`select id, email, phone, email_hash, phone_e164 from persons where (email is not null and email_hash is null) or (phone is not null and phone_e164 is null)`),
  );
  for (const r of rows) {
    await db
      .update(persons)
      .set({ ...(r.email && !r.email_hash ? { emailHash: emailHash(r.email) } : {}), ...(r.phone && !r.phone_e164 ? { phoneE164: normalisePhone(r.phone) } : {}) })
      .where(eq(persons.id, r.id));
  }
  return rows.length;
}

async function staffOwner(db: DbOrTx, ids: Map<string, string>, role: string): Promise<string | null> {
  const known = ids.get(`platform.user.${role}`) ?? ids.get("platform.user.owner");
  if (known) return known;
  const [row] = await db.select({ id: users.id }).from(users).where(and(eq(users.audience, "staff"), eq(users.status, "active"))).limit(1);
  return row?.id ?? null;
}

export async function runCrmDemoSeed(s: Pick<SeedCtx, "db" | "now" | "ids">): Promise<{ created: number; skipped: number }> {
  const { db, now, ids } = s;
  let created = 0;
  let skipped = 0;
  await backfillIdentity(db);

  const tagIds = new Map((await db.select({ id: tags.id, key: tags.key }).from(tags)).map((t) => [t.key, t.id]));
  const personIds = new Map<number, string>();
  for (const p of demoPersons()) {
    const [existing] = await db.select({ id: persons.id }).from(persons).where(sql`lower(${persons.email}) = ${p.email}`);
    let id = existing?.id;
    if (id) skipped++;
    else {
      const [row] = await db
        .insert(persons)
        .values({
          email: p.email,
          emailHash: emailHash(p.email),
          firstName: p.firstName,
          lastName: p.lastName,
          locale: p.locale,
          phone: p.phone,
          phoneE164: normalisePhone(p.phone),
          address: p.address,
          birthOn: p.birthOn,
          acquisition: p.acquisition,
          isTester: true,
          createdAt: new Date(now.getTime() - p.createdDaysAgo * DAY),
        })
        .returning({ id: persons.id });
      id = row!.id;
      created++;
    }
    personIds.set(p.n, id);
    ids.set(`crm.person.demo${p.n}`, id);
    for (const key of p.tags) {
      const tagId = tagIds.get(key);
      if (tagId) await db.insert(personTags).values({ personId: id, tagId, source: "manual", addedBy: SYSTEM }).onConflictDoNothing();
    }
  }

  const companyIds = new Map<string, string>();
  for (const c of DEMO_COMPANIES) {
    const inserted = await db
      .insert(companies)
      .values({ name: c.name, vatNumber: c.vatNumber, industry: c.industry, size: c.size, status: c.status, isPartner: c.isPartner, ...(c.isPartner ? { partnerCommissionPct: "10.00" } : {}) })
      .onConflictDoNothing()
      .returning({ id: companies.id });
    const id = inserted[0]?.id ?? (await db.select({ id: companies.id }).from(companies).where(eq(companies.vatNumber, c.vatNumber)))[0]!.id;
    if (inserted.length) created++;
    else skipped++;
    companyIds.set(c.slug, id);
    ids.set(`crm.company.${c.slug}`, id);
    for (const [i, n] of c.contacts.entries()) {
      const personId = personIds.get(n);
      if (personId) await db.insert(companyContacts).values({ companyId: id, personId, position: i === 0 ? "HR lead" : "Office manager", decisionRole: i === 0 ? "decision_maker" : "influencer", isPrimary: i === 0 }).onConflictDoNothing();
    }
  }
  const partner = companyIds.get("kine-plus");
  const referred = personIds.get(6);
  if (partner && referred) await db.update(persons).set({ partnerCompanyId: partner }).where(and(eq(persons.id, referred), isNull(persons.partnerCompanyId)));

  for (const [i, t] of DEMO_TASKS.entries()) {
    const owner = await staffOwner(db, ids, t.role);
    if (!owner) {
      skipped++;
      continue;
    }
    const rows = await db
      .insert(tasks)
      .values({
        ownerUserId: owner,
        title: t.title,
        kind: t.kind,
        priority: t.priority,
        dueAt: new Date(now.getTime() + t.dueInDays * DAY + 10 * 60 * 60 * 1000),
        personId: t.person ? (personIds.get(t.person) ?? null) : null,
        companyId: t.company ? (companyIds.get(t.company) ?? null) : null,
        source: "manual",
        createdBy: SYSTEM,
        dedupeKey: `demo:task:${i + 1}`,
      })
      .onConflictDoNothing({ target: tasks.dedupeKey })
      .returning({ id: tasks.id });
    if (rows.length) created++;
    else skipped++;
  }
  return { created, skipped };
}

export const seed = {
  after: ["platform"],
  run: (s: SeedCtx) => runCrmDemoSeed(s),
};
