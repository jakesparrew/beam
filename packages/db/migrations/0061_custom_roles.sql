-- Custom roles (owner's review section 11): roles.key and users.role_key become text so an
-- administrator can add roles. The FK and the checks that compare with enum literals are
-- dropped first and put back unchanged once both columns are text.
ALTER TABLE "users" DROP CONSTRAINT "users_role_key_roles_key_fk";--> statement-breakpoint
ALTER TABLE "users" DROP CONSTRAINT "users_partner_person_ck";--> statement-breakpoint
ALTER TABLE "roles" DROP CONSTRAINT "roles_owner_all_ck";--> statement-breakpoint
ALTER TABLE "roles" ALTER COLUMN "key" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "role_key" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."roles_key";--> statement-breakpoint
ALTER TABLE "roles" ADD CONSTRAINT "roles_owner_all_ck" CHECK ("roles"."key" <> 'owner' or "roles"."permissions" = '{*}'::text[]);--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_partner_person_ck" CHECK ("users"."role_key" <> 'external_partner' or "users"."person_id" is not null);--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_role_key_roles_key_fk" FOREIGN KEY ("role_key") REFERENCES "public"."roles"("key") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "roles" ADD CONSTRAINT "roles_key_ck" CHECK ("roles"."key" ~ '^[a-z][a-z0-9_]{1,47}$');--> statement-breakpoint
-- The four predefined roles keep their keys, so every existing user keeps its role:
-- owner = Administrator, management = Manager, reception = Front Desk, finance = Finance / Accounts.
UPDATE "roles" SET "name" = '{"nl-BE": "Beheerder", "fr-BE": "Administrateur", "en": "Administrator"}'::jsonb, "description" = '{"nl-BE": "Volledige toegang: alle functies, instellingen, gegevens en technische logboeken.", "fr-BE": "Accès complet : toutes les fonctions, paramètres, données et journaux techniques.", "en": "Full access: all functionality, settings, data and technical logs."}'::jsonb WHERE "key" = 'owner';--> statement-breakpoint
UPDATE "roles" SET "name" = '{"nl-BE": "Manager", "fr-BE": "Manager", "en": "Manager"}'::jsonb, "description" = '{"nl-BE": "Dagelijkse werking en beheer, zonder technische logboeken, gebruikersbeheer, gevoelige systeeminstellingen of gezondheidsgegevens.", "fr-BE": "Fonctionnement quotidien et gestion, sans journaux techniques, gestion des utilisateurs, paramètres système sensibles ni données de santé.", "en": "Day-to-day operations and management, without technical logs, user management, sensitive system settings or health data."}'::jsonb WHERE "key" = 'management';--> statement-breakpoint
UPDATE "roles" SET "name" = '{"nl-BE": "Onthaal", "fr-BE": "Accueil", "en": "Front Desk"}'::jsonb, "description" = '{"nl-BE": "Kassa, boekingen en klantgegevens, zonder financiële rapporten.", "fr-BE": "Caisse, réservations et données clients, sans rapports financiers.", "en": "Till (POS), bookings and client information, without financial reports."}'::jsonb WHERE "key" = 'reception';--> statement-breakpoint
UPDATE "roles" SET "name" = '{"nl-BE": "Financiën / Boekhouding", "fr-BE": "Finances / Comptabilité", "en": "Finance / Accounts"}'::jsonb, "description" = '{"nl-BE": "Financiële gegevens: transacties, facturen, betalingen, terugbetalingen en financiële rapporten.", "fr-BE": "Informations financières : transactions, factures, paiements, remboursements et rapports financiers.", "en": "Financial information: transactions, invoices, payments, refunds and financial reporting."}'::jsonb WHERE "key" = 'finance';--> statement-breakpoint
-- Manager: no sensitive system settings, so no feature flags (users, system jobs, privacy runs
-- and sensitive data were already left out). seeded_permissions keeps it, so no seed re-grants it.
UPDATE "roles" SET "permissions" = array_remove("permissions", 'flags.manage') WHERE "key" = 'management';--> statement-breakpoint
-- The other built-in roles stay with their users and permissions, as editable roles that an
-- administrator may rename, change or delete (once nobody holds them).
UPDATE "roles" SET "is_system" = false WHERE "key" IN ('customer_service', 'sales', 'marketing', 'technical_admin');
