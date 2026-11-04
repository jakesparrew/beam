/**
 * automation's `defaults` seed profile (runbook 3.4, BS-11; automation spec 3.6, automation-P4),
 * also run in production. Writes the seeded groups, the tags the journeys use, the block-backed
 * templates of section 3.6 and every seeded journey with a published version 1.
 *
 * Idempotent and never overwriting (decisions 30 and 38): groups and tags are inserted
 * `on conflict (key) do nothing`, a template only when its slug is absent (`seedTemplate`), and a
 * journey only when its slug is absent, so an edited, paused or archived journey is never touched
 * and a journey BEAM deactivated is never re-activated. V1 journeys start `active`, R2 journeys
 * `draft` with their published version. `apps/web`'s `seedAutomation(tx)` runs the same writer
 * with email's `seedTemplate` api.
 *
 * Decision: the tags `engaged`, `package_nearly_used`, `dormant` and `reviewed` are inserted here
 * (`is_system = true`) because the journeys' tag steps and conditions need them (A-1 `tag_unknown`);
 * crm's own seed lists its system tags.
 */
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { canonicalJson, parseDefinition, type Definition } from "@beam/core/automation";
import { SEED_AUTOMATIONS, SEED_GROUPS, SEED_TAGS, seedTemplates, type SeedAutomation } from "@beam/core/automation/seeds";
import type { SeedTemplateInput } from "@beam/core/email";
import type { DbOrTx } from "../client";
import { automationGroups, automations, automationVersions } from "../schema/automation";
import { tags } from "../schema/crm";
import { insertSeededTemplate } from "./email";
import type { DefaultSeed } from "./run";

/** Writes one block-backed template when its slug is absent (`email.seedTemplate` or `insertSeededTemplate`). */
export type SeedTemplateWriter = (db: DbOrTx, input: SeedTemplateInput) => Promise<{ templateId: string; created: boolean }>;

export type AutomationSeedCounts = { groups: number; automations: number; templates: number };

/** sha256 of the canonical JSON of a definition (`automation_versions.definition_hash`). */
export function definitionHash(def: Definition): string {
  return createHash("sha256").update(canonicalJson(def)).digest("hex");
}

/** Throws when a seed definition does not parse: a broken seed must never reach the database. */
function parsedDefinition(seed: SeedAutomation): Definition {
  const parsed = parseDefinition(seed.definition);
  if (!parsed.ok) throw new Error(`automation seed ${seed.slug} does not parse: ${parsed.issues.map((i) => `${i.path} ${i.message}`).join("; ")}`);
  return parsed.value;
}

/** Inserts one journey with its published version 1 unless the slug exists; returns whether it was created. */
export async function insertSeedAutomation(db: DbOrTx, seed: SeedAutomation, groupId: string, now: Date = new Date()): Promise<boolean> {
  const definition = parsedDefinition(seed);
  const [created] = await db
    .insert(automations)
    .values({
      slug: seed.slug,
      name: seed.name,
      description: seed.description,
      groupId,
      priority: seed.priority,
      status: "draft",
      isMarketing: seed.isMarketing,
      purpose: seed.purpose,
      draftDefinition: definition,
      draftUpdatedAt: now,
      requiresDpia: seed.requiresDpia,
      requiresFlag: seed.requiresFlag,
      createdByUserId: null,
    })
    .onConflictDoNothing({ target: automations.slug })
    .returning({ id: automations.id });
  if (!created) return false;
  // The version row first, then current_version_id (the two tables reference each other, spec 2.4).
  const [version] = await db
    .insert(automationVersions)
    .values({ automationId: created.id, version: 1, definition, definitionHash: definitionHash(definition), changeNote: "Version 1 (seed)", publishedAt: now, createdByUserId: null })
    .returning({ id: automationVersions.id });
  await db
    .update(automations)
    .set({ currentVersionId: version!.id, status: seed.status, activatedAt: seed.status === "active" ? now : null, updatedAt: now })
    .where(eq(automations.id, created.id));
  return true;
}

/** The seed of section 3.6: groups, tags, templates and journeys; counts what was created. */
export async function seedAutomationRows(
  db: DbOrTx,
  opts: { seedTemplate?: SeedTemplateWriter; seeds?: readonly SeedAutomation[]; now?: Date } = {},
): Promise<AutomationSeedCounts> {
  const seeds = opts.seeds ?? SEED_AUTOMATIONS;
  const writeTemplate = opts.seedTemplate ?? insertSeededTemplate;
  const now = opts.now ?? new Date();

  const groupsCreated = await db
    .insert(automationGroups)
    .values(SEED_GROUPS.map((g) => ({ key: g.key, name: g.name, description: g.description, isExclusive: g.isExclusive, lane: g.lane, priority: g.priority })))
    .onConflictDoNothing({ target: automationGroups.key })
    .returning({ id: automationGroups.id });

  await db
    .insert(tags)
    .values(SEED_TAGS.map((t) => ({ key: t.key, name: t.name, color: t.color, description: t.description, isSystem: true })))
    .onConflictDoNothing({ target: tags.key });

  let templates = 0;
  for (const t of seedTemplates(seeds)) if ((await writeTemplate(db, t)).created) templates++;

  const groupIds = new Map((await db.select({ id: automationGroups.id, key: automationGroups.key }).from(automationGroups)).map((g) => [g.key, g.id]));
  let created = 0;
  for (const seed of seeds) {
    const groupId = groupIds.get(seed.groupKey);
    if (!groupId) throw new Error(`automation seed ${seed.slug}: group ${seed.groupKey} does not exist`);
    if (await insertSeedAutomation(db, seed, groupId, now)) created++;
  }
  return { groups: groupsCreated.length, automations: created, templates };
}

export const seed: DefaultSeed = {
  after: ["platform", "crm", "email"],
  run: async (db) => {
    await seedAutomationRows(db);
  },
};
