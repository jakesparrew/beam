/**
 * platform's `defaults` seed: the nine built-in roles and their default permissions
 * (architecture section 4, platform spec section 7, PL-80). The predefined ones
 * (`PREDEFINED_ROLE_KEYS`: Administrator, Manager, Front Desk, Finance / Accounts and the
 * partner role) are `is_system`; the other four are editable, deletable roles.
 */
import { and, eq, not, sql } from "drizzle-orm";
import type { DbOrTx } from "../client";
import type { LocalizedText } from "../schema/_shared";
import { PREDEFINED_ROLE_KEYS, ROLE_KEYS, roles, type RoleKey, type SystemRoleKey } from "../schema/platform";
import type { DefaultSeed, SeedOptions } from "./run";

/** The V1 permission strings of architecture section 4 (fallback when no registry is passed). */
export const V1_PERMISSIONS = [
  "ai.use",
  "automations.move_person",
  "automations.publish",
  "automations.write",
  "bookings.override",
  "bookings.read",
  "bookings.write",
  "campaigns.send",
  "commerce.refund",
  "commerce.sell",
  "credits.adjust",
  "credits.read",
  "crm.b2b",
  "dashboards.manage",
  "email.send",
  "email.write",
  "flags.manage",
  "forms.publish",
  "forms.write",
  "invoices.issue",
  "invoices.read",
  "memberships.write",
  "partner.own",
  "persons.erase",
  "persons.export",
  "persons.merge",
  "persons.read",
  "persons.sensitive_read",
  "persons.write",
  "pricing.write",
  "privacy.run",
  "reports.finance",
  "reports.read",
  "settings.write",
  "site.edit",
  "site.publish",
  "system.jobs",
  "tasks.all",
  "users.manage",
  "waitlist.manage",
  "webinars.host",
] as const;

/** Permissions technical_admin does not get by default. */
const TECHNICAL_ADMIN_EXCLUDED = new Set(["persons.sensitive_read"]);
/**
 * Permissions the Manager (management) does not get by default: no technical logs, no sensitive
 * or dangerous system settings (users and roles, feature flags), no privacy runs or health data.
 */
export const MANAGEMENT_EXCLUDED: ReadonlySet<string> = new Set([
  "users.manage",
  "system.jobs",
  "flags.manage",
  "privacy.run",
  "persons.sensitive_read",
]);

/**
 * Default grants of module permissions to the roles other than owner, technical_admin and
 * management (architecture section 4; `referrals.manage` for finance and sales, D43). Applied
 * only for permissions present in the registry.
 */
export const DEFAULT_ROLE_GRANTS: Readonly<
  Record<
    Exclude<SystemRoleKey, "owner" | "technical_admin" | "management">,
    readonly string[]
  >
> = {
  customer_service: [
    "persons.read",
    "persons.write",
    "persons.merge",
    "bookings.read",
    "bookings.write",
    "waitlist.manage",
    "credits.read",
    "credits.adjust",
    "memberships.write",
    "tasks.all",
    "email.write",
    "reports.read",
  ],
  sales: [
    "persons.read",
    "persons.write",
    "bookings.read",
    "commerce.sell",
    "crm.b2b",
    "tasks.all",
    "reports.read",
    "ai.use",
    "referrals.manage",
  ],
  marketing: [
    "persons.read",
    "forms.write",
    "forms.publish",
    "email.write",
    "email.send",
    "campaigns.send",
    "automations.write",
    "automations.publish",
    "automations.move_person",
    "site.edit",
    "site.publish",
    "webinars.host",
    "reports.read",
    "ai.use",
  ],
  finance: [
    "persons.read",
    "invoices.read",
    "invoices.issue",
    "commerce.refund",
    "pricing.write",
    "credits.read",
    "reports.read",
    "reports.finance",
    "referrals.manage",
  ],
  reception: [
    "persons.read",
    "persons.write",
    "bookings.read",
    "bookings.write",
    "waitlist.manage",
    "commerce.sell",
    "credits.read",
    "tasks.all",
  ],
  external_partner: ["partner.own"],
};

export const ROLE_NAMES: Readonly<Record<SystemRoleKey, Required<LocalizedText>>> = {
  owner: { "nl-BE": "Beheerder", "fr-BE": "Administrateur", en: "Administrator" },
  management: { "nl-BE": "Manager", "fr-BE": "Manager", en: "Manager" },
  customer_service: {
    "nl-BE": "Klantenservice",
    "fr-BE": "Service clientèle",
    en: "Customer service",
  },
  sales: { "nl-BE": "Verkoop", "fr-BE": "Ventes", en: "Sales" },
  marketing: { "nl-BE": "Marketing", "fr-BE": "Marketing", en: "Marketing" },
  finance: { "nl-BE": "Financiën / Boekhouding", "fr-BE": "Finances / Comptabilité", en: "Finance / Accounts" },
  reception: { "nl-BE": "Onthaal", "fr-BE": "Accueil", en: "Front Desk" },
  technical_admin: {
    "nl-BE": "Technisch beheerder",
    "fr-BE": "Administrateur technique",
    en: "Technical admin",
  },
  external_partner: {
    "nl-BE": "Externe partner",
    "fr-BE": "Partenaire externe",
    en: "External partner",
  },
};

export const ROLE_DESCRIPTIONS: Readonly<
  Record<SystemRoleKey, Required<LocalizedText>>
> = {
  owner: {
    "nl-BE": "Volledige toegang: alle functies, instellingen, gegevens en technische logboeken.",
    "fr-BE": "Accès complet : toutes les fonctions, paramètres, données et journaux techniques.",
    en: "Full access: all functionality, settings, data and technical logs.",
  },
  management: {
    "nl-BE":
      "Dagelijkse werking en beheer, zonder technische logboeken, gebruikersbeheer, gevoelige systeeminstellingen of gezondheidsgegevens.",
    "fr-BE":
      "Fonctionnement quotidien et gestion, sans journaux techniques, gestion des utilisateurs, paramètres système sensibles ni données de santé.",
    en: "Day-to-day operations and management, without technical logs, user management, sensitive system settings or health data.",
  },
  customer_service: {
    "nl-BE": "Klanten, boekingen, wachtlijsten, tegoeden en taken.",
    "fr-BE": "Clients, réservations, listes d'attente, crédits et tâches.",
    en: "Customers, bookings, waitlists, credits and tasks.",
  },
  sales: {
    "nl-BE": "Klanten, verkoop, B2B en taken.",
    "fr-BE": "Clients, ventes, B2B et tâches.",
    en: "Customers, sales, B2B and tasks.",
  },
  marketing: {
    "nl-BE":
      "Formulieren, e-mail, campagnes, automatisaties, website en webinars.",
    "fr-BE":
      "Formulaires, e-mails, campagnes, automatisations, site web et webinaires.",
    en: "Forms, email, campaigns, automations, website and webinars.",
  },
  finance: {
    "nl-BE": "Financiële gegevens: transacties, facturen, betalingen, terugbetalingen en financiële rapporten.",
    "fr-BE": "Informations financières : transactions, factures, paiements, remboursements et rapports financiers.",
    en: "Financial information: transactions, invoices, payments, refunds and financial reporting.",
  },
  reception: {
    "nl-BE": "Kassa, boekingen en klantgegevens, zonder financiële rapporten.",
    "fr-BE": "Caisse, réservations et données clients, sans rapports financiers.",
    en: "Till (POS), bookings and client information, without financial reports.",
  },
  technical_admin: {
    "nl-BE": "Alle rechten behalve het lezen van gevoelige gegevens.",
    "fr-BE": "Tous les droits sauf la lecture des données sensibles.",
    en: "Every permission except reading sensitive data.",
  },
  external_partner: {
    "nl-BE": "Alleen de eigen partnergegevens, zonder klantgegevens.",
    "fr-BE":
      "Uniquement ses propres données de partenaire, sans données clients.",
    en: "Only their own partner figures, without customer data.",
  },
};

/**
 * Adds `permission` to the role only when a seed never granted it before, then records it in
 * `seeded_permissions`, so a permission the owner removed is never re-granted (PL-80). The
 * owner already holds `'*'` and only gets the bookkeeping entry. Returns true when it granted.
 */
export async function grantDefaultPermission(
  tx: DbOrTx,
  roleKey: RoleKey,
  permission: string,
): Promise<boolean> {
  const updated = await tx
    .update(roles)
    .set({
      permissions: sql`case when ${roles.key} = 'owner' or ${permission} = any(${roles.permissions}) then ${roles.permissions} else array_append(${roles.permissions}, ${permission}::text) end`,
      seededPermissions: sql`array_append(${roles.seededPermissions}, ${permission}::text)`,
    })
    .where(
      and(
        eq(roles.key, roleKey),
        not(sql`${permission} = any(${roles.seededPermissions})`),
      ),
    )
    .returning({ id: roles.id });
  return updated.length > 0 && roleKey !== "owner";
}

/** The roles that receive `permission` by default. */
export function defaultRolesFor(permission: string): SystemRoleKey[] {
  const out: SystemRoleKey[] = [];
  if (!TECHNICAL_ADMIN_EXCLUDED.has(permission)) out.push("technical_admin");
  if (!MANAGEMENT_EXCLUDED.has(permission)) out.push("management");
  for (const [role, list] of Object.entries(DEFAULT_ROLE_GRANTS) as [
    SystemRoleKey,
    readonly string[],
  ][]) {
    if (list.includes(permission)) out.push(role);
  }
  return out;
}

const PREDEFINED = new Set<string>(PREDEFINED_ROLE_KEYS);

async function run(db: DbOrTx, options: SeedOptions): Promise<void> {
  // The other built-in roles are starter roles of a fresh database only: an administrator may
  // rename or delete them, so a later run must not bring them back.
  const fresh = (await db.select({ id: roles.id }).from(roles).where(eq(roles.key, "owner"))).length === 0;
  for (const key of ROLE_KEYS) {
    const predefined = PREDEFINED.has(key);
    if (!predefined && !fresh) continue;
    const insert = db.insert(roles).values({
      key,
      name: ROLE_NAMES[key],
      description: ROLE_DESCRIPTIONS[key],
      permissions: key === "owner" ? ["*"] : [],
      isSystem: predefined,
    });
    await (predefined
      ? insert.onConflictDoUpdate({
          target: roles.key,
          set: { name: ROLE_NAMES[key], description: ROLE_DESCRIPTIONS[key], isSystem: true },
        })
      : insert.onConflictDoNothing({ target: roles.key }));
  }
  const registry = [...new Set(options.permissions ?? V1_PERMISSIONS)].sort();
  for (const permission of registry) {
    for (const role of defaultRolesFor(permission))
      await grantDefaultPermission(db, role, permission);
  }
}

export const seed = {
  after: [],
  run,
} satisfies DefaultSeed;
