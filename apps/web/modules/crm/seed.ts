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
 * - 6 ordinary (non-tester) demo customers at `@demo.beam.be` (`DEMO_CUSTOMERS`, ops-P10
 *   request; only once a staff user exists) and one open B2B opportunity of BrightOps owned by a
 *   staff user, so the `ai` schema
 *   and the ops reports show data; commerce gives the customers paid orders.
 * - 3 support knowledge articles in three locales (R4 AI reply drafts; BEAM policy, no person
 *   data), by key; an existing article is never overwritten (staff may have edited it).
 *
 * Inserted directly (crm's api lands with crm-P2); idempotent: persons by address, companies by
 * VAT number, tasks by `dedupe_key`, tags and contacts on their unique keys. Ids are recorded as
 * `crm.person.demo<n>`, `crm.company.<slug>`.
 */
import type { DbOrTx } from "@beam/db";
import { companies, companyContacts, opportunities, persons, personTags, supportKnowledgeArticles, tags, tasks, users, type AcquisitionJson, type PostalAddressJson } from "@beam/db/schema";
import { brusselsDay, emailHash, normalisePhone, type AcquisitionSource } from "@beam/core/crm";
import type { Locale } from "@beam/core/i18n";
import { and, createCtx, eq, isNull, sql } from "@/lib/ctx";
import { rowsOf } from "@/lib/sensitive";
import type { SeedCtx } from "@/scripts/seed-demo";
import { ingestInboundEmail } from "./inbox/api";

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

/**
 * ops-P10 request: a few ordinary (non-tester) demo customers, so the `ai` schema (which leaves
 * testers out, ops spec 2.4) and the ops reports show data on a demo database. `@demo.beam.be`
 * addresses, invented names, no real data. commerce's demo seed gives them paid orders (one buys
 * the 10-session package). Ids are recorded as `crm.customer.<slug>`.
 */
export const DEMO_CUSTOMERS: readonly {
  slug: string;
  firstName: string;
  lastName: string;
  locale: Locale;
  source: AcquisitionSource;
  campaign?: string;
  createdDaysAgo: number;
}[] = [
  { slug: "an-verbruggen", firstName: "An", lastName: "Verbruggen", locale: "nl-BE", source: "website", createdDaysAgo: 110 },
  { slug: "koen-de-wilde", firstName: "Koen", lastName: "De Wilde", locale: "nl-BE", source: "paid_meta", campaign: "spring-sleep", createdDaysAgo: 95 },
  { slug: "sarah-lenaerts", firstName: "Sarah", lastName: "Lenaerts", locale: "nl-BE", source: "referral", createdDaysAgo: 80 },
  { slug: "julie-moreau", firstName: "Julie", lastName: "Moreau", locale: "fr-BE", source: "organic_search", createdDaysAgo: 70 },
  { slug: "marc-gerard", firstName: "Marc", lastName: "Gérard", locale: "fr-BE", source: "event", createdDaysAgo: 60 },
  { slug: "hannah-clarke", firstName: "Hannah", lastName: "Clarke", locale: "en", source: "social_media", createdDaysAgo: 45 },
];

/**
 * More ordinary demo customers (same shape and `crm.customer.<slug>` ids as `DEMO_CUSTOMERS`):
 * commerce sells them packages and memberships, credits imports a legacy package and a legacy
 * membership, booking books their visits, so the dashboard queues and the reports show people.
 */
export const DEMO_REGULARS: typeof DEMO_CUSTOMERS = [
  { slug: "lies-vermeulen", firstName: "Lies", lastName: "Vermeulen", locale: "nl-BE", source: "website", createdDaysAgo: 92 },
  { slug: "tom-claes", firstName: "Tom", lastName: "Claes", locale: "nl-BE", source: "organic_search", createdDaysAgo: 115 },
  { slug: "nora-dumont", firstName: "Nora", lastName: "Dumont", locale: "fr-BE", source: "social_media", createdDaysAgo: 40 },
  { slug: "pieter-de-backer", firstName: "Pieter", lastName: "De Backer", locale: "nl-BE", source: "referral", createdDaysAgo: 118 },
  { slug: "eline-wouters", firstName: "Eline", lastName: "Wouters", locale: "nl-BE", source: "walk_in", createdDaysAgo: 210 },
  { slug: "geert-lemmens", firstName: "Geert", lastName: "Lemmens", locale: "nl-BE", source: "import", createdDaysAgo: 400 },
  { slug: "sophie-laurent", firstName: "Sophie", lastName: "Laurent", locale: "fr-BE", source: "paid_meta", campaign: "autumn-recovery", createdDaysAgo: 55 },
  { slug: "james-cooper", firstName: "James", lastName: "Cooper", locale: "en", source: "website", createdDaysAgo: 38 },
];

/** New leads of the last two weeks (no booking, no task): the dashboard's "follow up new leads". */
export const DEMO_LEADS: typeof DEMO_CUSTOMERS = [
  { slug: "lena-hermans", firstName: "Lena", lastName: "Hermans", locale: "nl-BE", source: "landing_page", campaign: "sleep-guide", createdDaysAgo: 3 },
  { slug: "mathis-lejeune", firstName: "Mathis", lastName: "Lejeune", locale: "fr-BE", source: "paid_meta", campaign: "autumn-recovery", createdDaysAgo: 5 },
  { slug: "ella-wright", firstName: "Ella", lastName: "Wright", locale: "en", source: "organic_search", createdDaysAgo: 8 },
  { slug: "wout-goossens", firstName: "Wout", lastName: "Goossens", locale: "nl-BE", source: "webinar", createdDaysAgo: 10 },
  { slug: "camille-renard", firstName: "Camille", lastName: "Renard", locale: "fr-BE", source: "website", createdDaysAgo: 12 },
];

export const demoCustomerEmail = (slug: string): string => `${slug.replace("-", ".")}@demo.beam.be`;

/** More B2B opportunities over the pipeline stages (by company and title, so a rerun adds none). */
export const DEMO_OPPORTUNITIES: readonly {
  company: (typeof DEMO_COMPANIES)[number]["slug"];
  title: string;
  stage: (typeof opportunities.$inferInsert)["stage"] & string;
  valueCents: number;
  probabilityPct: number;
  contact: number | null;
  enteredDaysAgo: number;
  closesInDays: number;
  /** Days until the next action; negative = overdue. */
  nextInDays: number | null;
  lostReason?: string;
}[] = [
  { company: "zorgpunt", title: "Team recovery days spring 2027", stage: "negotiation", valueCents: 320_000, probabilityPct: 70, contact: 2, enteredDaysAgo: 9, closesInDays: 14, nextInDays: -1 },
  { company: "atelier-lumiere", title: "Wellness vouchers for staff", stage: "qualified", valueCents: 150_000, probabilityPct: 30, contact: 20, enteredDaysAgo: 4, closesInDays: 45, nextInDays: 2 },
  { company: "hotel-de-linde", title: "Guest recovery partnership", stage: "outreach", valueCents: 90_000, probabilityPct: 15, contact: null, enteredDaysAgo: 12, closesInDays: 60, nextInDays: 0 },
  { company: "kine-plus", title: "Patient referral programme 2027", stage: "won", valueCents: 60_000, probabilityPct: 100, contact: 5, enteredDaysAgo: 12, closesInDays: -12, nextInDays: null },
  { company: "hotel-de-linde", title: "Corporate overnight package", stage: "lost", valueCents: 210_000, probabilityPct: 0, contact: null, enteredDaysAgo: 25, closesInDays: -25, nextInDays: null, lostReason: "Budget frozen for 2026" },
];

/** Open follow-up tasks on the ordinary demo customers and the pipeline (`demo:task:activity:<n>`). */
const DEMO_ACTIVITY_TASKS: readonly { title: string; kind: (typeof tasks.$inferInsert)["kind"]; role: string; customer?: string; company?: string; dueInDays: number; priority: "low" | "normal" | "high" }[] = [
  { title: "Call about the membership renewal", kind: "call", role: "customer_service", customer: "geert-lemmens", dueInDays: 2, priority: "high" },
  { title: "Offer a new package before the last session", kind: "follow_up", role: "customer_service", customer: "lies-vermeulen", dueInDays: 0, priority: "normal" },
  { title: "Welcome call after the first night", kind: "follow_up", role: "reception", customer: "hannah-clarke", dueInDays: -1, priority: "normal" },
  { title: "Remind about credits that expire soon", kind: "follow_up", role: "customer_service", customer: "eline-wouters", dueInDays: 1, priority: "normal" },
  { title: "Invite back for a first visit with the 50-hour package", kind: "call", role: "sales", customer: "pieter-de-backer", dueInDays: 4, priority: "high" },
  { title: "Send the negotiated proposal", kind: "proposal", role: "sales", company: "zorgpunt", dueInDays: -3, priority: "high" },
];

/** ops-P10 request: one open B2B opportunity of a demo company (by title, so a rerun adds none). */
export const DEMO_OPPORTUNITY = {
  company: "brightops",
  title: "Corporate recovery programme pilot",
  stage: "proposal",
  valueCents: 480_000,
  probabilityPct: 40,
  closesInDays: 30,
  contact: 33,
} as const;

/**
 * Inserts the non-tester demo customers and the demo opportunity (after `runCrmDemoSeed`, which
 * creates the companies). Idempotent: persons by address, the opportunity by company and title.
 * They belong to the staff-facing demo (a staff user owns the opportunity and works the orders),
 * so a database without any active staff user (a demo run without the demo staff credentials)
 * gets none of them and keeps no non-tester person.
 */
export async function runCrmDemoCustomersSeed(s: Pick<SeedCtx, "db" | "now" | "ids">): Promise<{ created: number; skipped: number }> {
  const { db, now, ids } = s;
  let created = 0;
  let skipped = 0;
  const owner = await staffOwner(db, ids, "sales");
  if (!owner) return { created, skipped: DEMO_CUSTOMERS.length + 1 };
  for (const c of [...DEMO_CUSTOMERS, ...DEMO_REGULARS, ...DEMO_LEADS]) {
    const email = demoCustomerEmail(c.slug);
    const [existing] = await db.select({ id: persons.id }).from(persons).where(sql`lower(${persons.email}) = ${email}`);
    let id = existing?.id;
    if (id) skipped++;
    else {
      const [row] = await db
        .insert(persons)
        .values({
          email,
          emailHash: emailHash(email),
          firstName: c.firstName,
          lastName: c.lastName,
          locale: c.locale,
          acquisition: { source: c.source, ...(c.campaign ? { campaign: c.campaign, medium: "cpc" } : {}), captured_at: new Date(now.getTime() - c.createdDaysAgo * DAY).toISOString() },
          isTester: false,
          createdAt: new Date(now.getTime() - c.createdDaysAgo * DAY),
        })
        .returning({ id: persons.id });
      id = row!.id;
      created++;
    }
    ids.set(`crm.customer.${c.slug}`, id);
  }

  const o = DEMO_OPPORTUNITY;
  const vat = DEMO_COMPANIES.find((c) => c.slug === o.company)!.vatNumber;
  const [company] = await db.select({ id: companies.id }).from(companies).where(eq(companies.vatNumber, vat));
  if (!company) return { created, skipped: skipped + 1 };
  const [known] = await db.select({ id: opportunities.id }).from(opportunities).where(and(eq(opportunities.companyId, company.id), eq(opportunities.title, o.title)));
  if (known) {
    ids.set("crm.opportunity.demo", known.id);
    return { created, skipped: skipped + 1 };
  }
  const [contact] = await db.select({ id: persons.id }).from(persons).where(sql`lower(${persons.email}) = ${`crm-demo-${o.contact}@example.com`}`);
  const [row] = await db
    .insert(opportunities)
    .values({
      companyId: company.id,
      title: o.title,
      primaryContactPersonId: contact?.id ?? null,
      stage: o.stage,
      stageEnteredAt: new Date(now.getTime() - 6 * DAY),
      valueCents: o.valueCents,
      probabilityPct: o.probabilityPct,
      expectedCloseOn: brusselsDay(new Date(now.getTime() + o.closesInDays * DAY + 12 * 60 * 60 * 1000)),
      ownerUserId: owner,
      nextAction: "Follow up on the proposal",
      nextActionAt: new Date(now.getTime() + 3 * DAY + 10 * 60 * 60 * 1000),
      source: "demo",
      createdAt: new Date(now.getTime() - 20 * DAY),
    })
    .returning({ id: opportunities.id });
  ids.set("crm.opportunity.demo", row!.id);
  return { created: created + 1, skipped };
}

/**
 * `DEMO_OPPORTUNITIES` and `DEMO_ACTIVITY_TASKS` (after `runCrmDemoCustomersSeed`, which records
 * the customers). Idempotent: opportunities by company and title, tasks by `dedupe_key`.
 */
export async function runCrmDemoPipelineSeed(s: Pick<SeedCtx, "db" | "now" | "ids">): Promise<{ created: number; skipped: number }> {
  const { db, now, ids } = s;
  let created = 0;
  let skipped = 0;
  const at = (days: number, hour = 10) => new Date(now.getTime() + days * DAY + hour * 60 * 60 * 1000);
  const sales = await staffOwner(db, ids, "sales");
  if (!sales) return { created, skipped: DEMO_OPPORTUNITIES.length + DEMO_ACTIVITY_TASKS.length };
  for (const o of DEMO_OPPORTUNITIES) {
    const companyId = ids.get(`crm.company.${o.company}`);
    if (!companyId) {
      skipped++;
      continue;
    }
    const [known] = await db.select({ id: opportunities.id }).from(opportunities).where(and(eq(opportunities.companyId, companyId), eq(opportunities.title, o.title)));
    if (known) {
      skipped++;
      continue;
    }
    const entered = at(-o.enteredDaysAgo, 9);
    await db.insert(opportunities).values({
      companyId,
      title: o.title,
      primaryContactPersonId: o.contact ? (ids.get(`crm.person.demo${o.contact}`) ?? null) : null,
      stage: o.stage,
      stageEnteredAt: entered,
      valueCents: o.valueCents,
      probabilityPct: o.probabilityPct,
      expectedCloseOn: brusselsDay(at(o.closesInDays, 12)),
      ownerUserId: sales,
      nextAction: o.nextInDays === null ? null : "Follow up with the contact",
      nextActionAt: o.nextInDays === null ? null : at(o.nextInDays),
      wonAt: o.stage === "won" ? entered : null,
      lostAt: o.stage === "lost" ? entered : null,
      lostReason: o.lostReason ?? null,
      source: "demo",
      createdAt: at(-o.enteredDaysAgo - 21, 9),
    });
    created++;
  }
  for (const [i, t] of DEMO_ACTIVITY_TASKS.entries()) {
    const owner = await staffOwner(db, ids, t.role);
    const rows = await db
      .insert(tasks)
      .values({
        ownerUserId: owner ?? sales,
        title: t.title,
        kind: t.kind,
        priority: t.priority,
        dueAt: at(t.dueInDays),
        personId: t.customer ? (ids.get(`crm.customer.${t.customer}`) ?? null) : null,
        companyId: t.company ? (ids.get(`crm.company.${t.company}`) ?? null) : null,
        source: "manual",
        createdBy: SYSTEM,
        dedupeKey: `demo:task:activity:${i + 1}`,
      })
      .onConflictDoNothing({ target: tasks.dedupeKey })
      .returning({ id: tasks.id });
    if (rows.length) created++;
    else skipped++;
  }
  return { created, skipped };
}

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

  // A few customer emails for the inbox (R3, behind ff_crm_inbox): what the training guide's
  // inbox screenshot shows. Ingested as Resend Inbound would; the message ids make it idempotent.
  for (const [i, m] of DEMO_INBOX.entries()) {
    const p = demoPersons().find((d) => d.n === m.person);
    if (!p) continue;
    const before = created;
    await db.transaction(async (tx) => {
      const at = new Date(now.getTime() - m.hoursAgo * 60 * 60 * 1000);
      const ctx = createCtx({ tx, actor: { kind: "system", jobId: "seed:crm" }, requestId: "seed:crm:inbox", now: at, durableMode: "immediate" });
      const messageId = `<demo-inbox-${i + 1}@demo.beam.be>`;
      const [seen] = rowsOf<{ n: number }>(await tx.execute(sql`select count(*)::int as n from inbox_messages where external_message_id = ${messageId}`));
      if (Number(seen?.n ?? 0) > 0) return;
      await ingestInboundEmail(tx, ctx, { messageId, from: p.email, fromName: `${p.firstName} ${p.lastName}`, subject: m.subject, text: m.text, attachmentCount: 0, receivedAt: at });
      created++;
    });
    if (created === before) skipped++;
  }
  return { created, skipped };
}

/** Demo customer emails for the inbox (person = `demoPersons()` number). */
const DEMO_INBOX: readonly { person: number; hoursAgo: number; subject: string; text: string }[] = [
  { person: 2, hoursAgo: 3, subject: "Sessie verplaatsen naar volgende week?", text: "Hallo, ik heb donderdag een sessie geboekt maar kan helaas niet. Kan ik die verplaatsen naar volgende week dinsdag? Groetjes" },
  { person: 20, hoursAgo: 20, subject: "Question sur mon abonnement", text: "Bonjour, mon abonnement se renouvelle le mois prochain. Puis-je passer à la formule nuit sans payer deux fois ? Merci" },
  { person: 35, hoursAgo: 46, subject: "Gift voucher for a friend", text: "Hi, I would like to buy a gift voucher for a friend's birthday. Can it be used for a night session too? Thanks!" },
];

/** Demo BEAM policies for the inbox AI drafts (crm rule 3.58): plain text, complete in every locale. */
export const DEMO_KNOWLEDGE_ARTICLES: readonly { key: string; title: Record<Locale, string>; body: Record<Locale, string> }[] = [
  {
    key: "booking-cancellation",
    title: { "nl-BE": "Annuleren en verplaatsen", "fr-BE": "Annuler et déplacer", en: "Cancelling and rescheduling" },
    body: {
      "nl-BE":
        "Een boeking annuleer of verplaats je zelf in je account tot de annuleringstermijn in je bevestiging. Binnen die termijn neem je contact op met de receptie; credits van een sessie die je niet annuleert, worden niet teruggezet.",
      "fr-BE":
        "Vous annulez ou déplacez une réservation vous-même dans votre compte jusqu'au délai d'annulation indiqué dans votre confirmation. Passé ce délai, contactez l'accueil ; les crédits d'une séance non annulée ne sont pas restitués.",
      en: "You cancel or reschedule a booking yourself in your account until the cancellation deadline shown in your confirmation. After that deadline, contact reception; credits for a session you do not cancel are not returned.",
    },
  },
  {
    key: "what-to-bring",
    title: { "nl-BE": "Wat breng je mee", "fr-BE": "Que faut-il apporter", en: "What to bring" },
    body: {
      "nl-BE": "Breng sportkledij, een handdoek en een drinkfles mee. Kom tien minuten voor de start, zodat je rustig kunt omkleden en inchecken aan de receptie.",
      "fr-BE": "Apportez une tenue de sport, une serviette et une gourde. Arrivez dix minutes avant le début pour vous changer et vous enregistrer à l'accueil en toute tranquillité.",
      en: "Bring sportswear, a towel and a water bottle. Arrive ten minutes before the start so you can change and check in at reception without hurrying.",
    },
  },
  {
    key: "credits-and-packages",
    title: { "nl-BE": "Credits en pakketten", "fr-BE": "Crédits et forfaits", en: "Credits and packages" },
    body: {
      "nl-BE": "Je saldo en de vervaldatum van je pakketten zie je in je account. Bij een boeking worden eerst de credits gebruikt die het snelst vervallen.",
      "fr-BE": "Votre solde et la date d'expiration de vos forfaits figurent dans votre compte. Lors d'une réservation, les crédits qui expirent en premier sont utilisés d'abord.",
      en: "Your balance and the expiry date of your packages are shown in your account. A booking uses the credits that expire first.",
    },
  },
];

/** Inserts the demo knowledge articles that do not exist yet (by key). */
export async function seedDemoKnowledgeArticles(db: DbOrTx): Promise<{ created: number; skipped: number }> {
  let created = 0;
  for (const a of DEMO_KNOWLEDGE_ARTICLES) {
    const rows = await db
      .insert(supportKnowledgeArticles)
      .values({ key: a.key, title: a.title, body: a.body, isActive: true })
      .onConflictDoNothing({ target: supportKnowledgeArticles.key })
      .returning({ id: supportKnowledgeArticles.id });
    created += rows.length;
  }
  return { created, skipped: DEMO_KNOWLEDGE_ARTICLES.length - created };
}

export const seed = {
  after: ["platform"],
  run: async (s: SeedCtx) => {
    const main = await runCrmDemoSeed(s);
    const customers = await runCrmDemoCustomersSeed(s);
    const pipeline = await runCrmDemoPipelineSeed(s);
    const articles = await seedDemoKnowledgeArticles(s.db);
    return {
      created: main.created + customers.created + pipeline.created + articles.created,
      skipped: main.skipped + customers.skipped + pipeline.skipped + articles.skipped,
    };
  },
};
