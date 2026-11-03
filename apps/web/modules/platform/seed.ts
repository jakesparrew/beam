/**
 * Platform's demo seed (runbook DR-12, DR-14, section 6.3). Facade read by `pnpm gen:indexes`.
 *
 * - Nine staff users `<role>@demo.beam.be` with the password `DEMO_STAFF_PASSWORD` and the TOTP
 *   secret `DEMO_TOTP_SECRET`, all MFA-enrolled (BS-20); owner and marketing are testers;
 *   the external partner is linked to a person (the users check needs one).
 * - 20 test persons `customer1@example.com` to `customer20@example.com`, inserted directly,
 *   with Belgian names in the three locales; the first five get a customer `users` row.
 * - The demo `company` setting (6.2) and every declared flag: V1 flags `on`, flags whose
 *   description names R2, R3 or R4 `off`. Existing rows are never changed (idempotent).
 * Refuses `APP_ENV=production` and a database with more than 500 non-tester persons
 * (edge case 28). The `roles` rows come from the defaults profile, which runs first (BS-11).
 */
import type { DbOrTx } from "@beam/db";
import { featureFlags, persons, settings, users, type RoleKey } from "@beam/db/schema";
import type { Locale } from "@beam/core/i18n";
import { generateRecoveryCodes, hashRecoveryCode } from "@beam/core/platform";
import { eq, sql } from "@/lib/ctx";
import { hashPassword } from "@/lib/password";
import { encryptSensitive, rowsOf, sensitiveAad } from "@/lib/sensitive";
import { FLAGS } from "@/registry/flags.generated";

export type DemoSeedContext = { tx: DbOrTx; now?: Date };
export type DemoSeedResult = { created: number; skipped: number };

export const DEMO_STAFF: readonly { role: RoleKey; name: string; locale: Locale; isTester: boolean }[] = [
  { role: "owner", name: "Gaëtan Demo", locale: "nl-BE", isTester: true },
  { role: "management", name: "Achille Demo", locale: "fr-BE", isTester: false },
  { role: "customer_service", name: "Sofie Demo", locale: "nl-BE", isTester: false },
  { role: "sales", name: "Thomas Demo", locale: "nl-BE", isTester: false },
  { role: "marketing", name: "Julie Demo", locale: "fr-BE", isTester: true },
  { role: "finance", name: "Marc Demo", locale: "nl-BE", isTester: false },
  { role: "reception", name: "Lien Demo", locale: "nl-BE", isTester: false },
  { role: "technical_admin", name: "Dev Demo", locale: "en", isTester: false },
  { role: "external_partner", name: "Partner Demo", locale: "en", isTester: false },
];

const NAMES: Record<Locale, { first: string[]; last: string[] }> = {
  "nl-BE": { first: ["Lotte", "Jonas", "Emma", "Noah", "Hanne", "Pieter", "Lien", "Wout", "Fien", "Arne"], last: ["Peeters", "Janssens", "Maes", "Jacobs", "Mertens", "Willems", "Claes", "Goossens", "Wouters", "De Smet"] },
  "fr-BE": { first: ["Camille", "Lucas", "Elise", "Marie", "Hugo", "Chloé"], last: ["Dubois", "Lambert", "Dupont", "Martin", "Simon", "Laurent"] },
  en: { first: ["Sarah", "James", "Olivia", "Ethan"], last: ["Smith", "Taylor", "Brown", "Wilson"] },
};

/** The 20 test persons: 10 `nl-BE`, 6 `fr-BE`, 4 `en`. */
export function demoPersons(): { email: string; firstName: string; lastName: string; locale: Locale }[] {
  const out: { email: string; firstName: string; lastName: string; locale: Locale }[] = [];
  const plan: [Locale, number][] = [["nl-BE", 10], ["fr-BE", 6], ["en", 4]];
  for (const [locale, count] of plan) {
    for (let i = 0; i < count; i++) {
      const n = out.length + 1;
      out.push({ email: `customer${n}@example.com`, firstName: NAMES[locale].first[i]!, lastName: NAMES[locale].last[i]!, locale });
    }
  }
  return out;
}

export const DEMO_CUSTOMER_USERS = 5;

export const DEMO_COMPANY = {
  legal_name: "Vibrant Lifestyle Collective BV",
  trade_name: "BEAM",
  vat_number: "BE0123456749",
  enterprise_number: "0123.456.749",
  address: { street: "Voorbeeldstraat 1", postal_code: "9000", city: "Gent", country: "BE" as const },
  support_email: "hello@demo.beam.be",
  phone: "+32 9 000 00 00",
  website: "https://www.beam.be",
};

function dbOf(ctx: DemoSeedContext | DbOrTx): DbOrTx {
  return typeof ctx === "object" && ctx !== null && "tx" in ctx && !("select" in ctx) ? (ctx as DemoSeedContext).tx : (ctx as DbOrTx);
}

async function guard(db: DbOrTx, env: Readonly<Record<string, string | undefined>>): Promise<{ password: string; totp: string }> {
  if (env.APP_ENV === "production") throw new Error("platform demo seed refuses APP_ENV=production (PL-79)");
  const [row] = rowsOf<{ n: number }>(await db.execute(sql`select count(*)::int as n from persons where not is_tester`));
  if (Number(row?.n ?? 0) > 500) throw new Error("platform demo seed refuses: more than 500 non-tester persons (edge case 28)");
  const password = env.DEMO_STAFF_PASSWORD;
  const totp = env.DEMO_TOTP_SECRET?.replace(/\s/g, "").toUpperCase();
  if (!password || !totp) throw new Error("platform demo seed needs DEMO_STAFF_PASSWORD and DEMO_TOTP_SECRET");
  return { password, totp };
}

async function personId(db: DbOrTx, input: { email: string; firstName: string; lastName: string; locale: Locale }): Promise<{ id: string; created: boolean }> {
  const [existing] = await db.select({ id: persons.id }).from(persons).where(sql`lower(${persons.email}) = ${input.email}`);
  if (existing) return { id: existing.id, created: false };
  const [row] = await db
    .insert(persons)
    .values({ ...input, isTester: true, acquisition: { source: "manual" } })
    .returning({ id: persons.id });
  return { id: row!.id, created: true };
}

async function userExists(db: DbOrTx, email: string): Promise<boolean> {
  const [row] = await db.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = ${email}`);
  return !!row;
}

export async function runPlatformDemoSeed(ctx: DemoSeedContext | DbOrTx, env: Readonly<Record<string, string | undefined>> = process.env): Promise<DemoSeedResult> {
  const db = dbOf(ctx);
  const { password, totp } = await guard(db, env);
  const now = (typeof ctx === "object" && "now" in ctx && ctx.now instanceof Date ? ctx.now : null) ?? new Date();
  let created = 0;
  let skipped = 0;
  let hash: string | null = null;

  for (const staff of DEMO_STAFF) {
    const email = `${staff.role}@demo.beam.be`;
    if (await userExists(db, email)) {
      skipped++;
      continue;
    }
    hash ??= await hashPassword(password);
    const partner = staff.role === "external_partner" ? await personId(db, { email, firstName: "Partner", lastName: "Demo", locale: staff.locale }) : null;
    const [row] = await db
      .insert(users)
      .values({ audience: "staff", email, name: staff.name, locale: staff.locale, roleKey: staff.role, isTester: staff.isTester, passwordHash: hash, passwordChangedAt: now, emailVerified: now, ...(partner ? { personId: partner.id } : {}) })
      .returning({ id: users.id });
    // Same storage as `writeMfaSecrets` in lib/auth.ts (not imported: the seed runs outside Next.js).
    const codes = await Promise.all(generateRecoveryCodes().map(async (c) => ({ hash: await hashRecoveryCode(c), used_at: null })));
    const secret = encryptSensitive(totp, sensitiveAad.totpSecret(row!.id));
    const stored = encryptSensitive(JSON.stringify(codes), sensitiveAad.recoveryCodes(row!.id), secret.keyVersion);
    await db
      .update(users)
      .set({ totpSecretEnc: secret.valueEnc, recoveryCodesEnc: stored.valueEnc, secretKeyVersion: secret.keyVersion, mfaEnrolledAt: now })
      .where(eq(users.id, row!.id));
    created++;
  }

  const people = demoPersons();
  for (const [index, person] of people.entries()) {
    const p = await personId(db, person);
    if (p.created) created++;
    else skipped++;
    if (index < DEMO_CUSTOMER_USERS) {
      const [account] = await db.select({ id: users.id }).from(users).where(eq(users.personId, p.id));
      if (account || (await userExists(db, person.email))) skipped++;
      else {
        await db.insert(users).values({ audience: "customer", email: person.email, name: `${person.firstName} ${person.lastName}`, locale: person.locale, personId: p.id, isTester: true, emailVerified: now });
        created++;
      }
    }
  }

  const company = await db.insert(settings).values({ key: "company", value: DEMO_COMPANY }).onConflictDoNothing({ target: settings.key }).returning({ id: settings.id });
  created += company.length;

  for (const def of Object.values(FLAGS as Readonly<Record<string, { key: string; description: string }>>)) {
    const state = /\bR[234]\b/.test(def.description) ? "off" : "on";
    const rows = await db.insert(featureFlags).values({ key: def.key, state, description: def.description }).onConflictDoNothing({ target: featureFlags.key }).returning({ id: featureFlags.id });
    created += rows.length;
  }
  return { created, skipped };
}

export const seed = {
  after: [],
  run: (ctx: DemoSeedContext | DbOrTx) => runPlatformDemoSeed(ctx),
};
