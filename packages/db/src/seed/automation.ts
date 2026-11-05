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
 * Decision: the tags `engaged`, `package_nearly_used`, `dormant` and `reviewed` (and the B2C
 * playbook's `repeat` and `lost`, automation-P8) are inserted here (`is_system = true`) because
 * the journeys' tag steps and conditions need them (A-1 `tag_unknown`); crm's own seed lists its
 * system tags.
 *
 * `activateReleaseSequences(tx, release)` (automation-P8, decision 30, A-5a) switches on the
 * seeded drafts of a release at its go-live: a seeded slug that is still `draft`, has a published
 * version and was never activated (`activated_at` null) becomes `active`. A journey BEAM
 * activated before and then paused or archived, or edited back to draft after an activation,
 * keeps its status, so a journey switched off stays off; a DPIA-gated journey stays draft while
 * its DPIA is not approved and is reported in `blocked`. Running it twice activates nothing new.
 */
import { createHash } from "node:crypto";
import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { canonicalJson, parseDefinition, type Definition } from "@beam/core/automation";
import { SEED_AUTOMATIONS, SEED_GROUPS, SEED_TAGS, seedsOfRelease, seedTemplates, type ActivationRelease, type SeedAutomation } from "@beam/core/automation/seeds";
import type { SeedTemplateInput } from "@beam/core/email";
import { isDpiaStatusApproved, type DpiaKey } from "@beam/core/ops";
import type { Db, DbOrTx, Tx } from "../client";
import { automationGroups, automations, automationVersions } from "../schema/automation";
import { tags } from "../schema/crm";
import { dpiaRecords } from "../schema/ops";
import { auditLog } from "../schema/platform";
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

// ---------------------------------------------------------------------------
// Release activation (automation-P8)
// ---------------------------------------------------------------------------

/** Reads whether a DPIA is approved (ops' `isDpiaApproved`; apps/web passes it). */
export type DpiaCheck = (db: DbOrTx, key: DpiaKey) => Promise<boolean>;

export type ActivateReleaseOptions = {
  /** ops' `isDpiaApproved`; the default reads `dpia_records` with ops' own rule (`approved` or `not_required`). */
  isDpiaApproved?: DpiaCheck;
  now?: Date;
  /** Only these seeds (tests); default every seed of the release. */
  seeds?: readonly SeedAutomation[];
};

export type ActivateReleaseResult = {
  /** Slugs switched on by this call, in seed order. */
  activated: string[];
  /** Slugs left draft because their DPIA is not approved (A-5a), as `<slug>:<dpia key>`. */
  blocked: string[];
};

/** The default DPIA read: ops rule 70 on `dpia_records.status` (a missing row is `not_started`). */
const readDpia: DpiaCheck = async (db, key) => {
  const [row] = await db.select({ status: dpiaRecords.status }).from(dpiaRecords).where(eq(dpiaRecords.key, key)).limit(1);
  return isDpiaStatusApproved(row?.status ?? "not_started");
};

/**
 * Activates the seeded drafts of `release` that were never activated (decision 30, A-5a); see
 * the file header. Locks the candidate rows, writes one `automation.activate` audit row per
 * journey with the system actor, and returns the activated slugs.
 */
export async function activateReleaseSequences(tx: Tx, release: ActivationRelease, opts: ActivateReleaseOptions = {}): Promise<ActivateReleaseResult> {
  const now = opts.now ?? new Date();
  const check = opts.isDpiaApproved ?? readDpia;
  const seeds = seedsOfRelease(release, opts.seeds ?? SEED_AUTOMATIONS);
  if (!seeds.length) return { activated: [], blocked: [] };
  const rows = await tx
    .select({ id: automations.id, slug: automations.slug, requiresDpia: automations.requiresDpia })
    .from(automations)
    .where(
      and(
        inArray(
          automations.slug,
          seeds.map((s) => s.slug),
        ),
        eq(automations.status, "draft"),
        isNull(automations.activatedAt),
        isNotNull(automations.currentVersionId),
      ),
    )
    .for("update");
  const bySlug = new Map(rows.map((r) => [r.slug, r]));
  const approved = new Map<string, boolean>();
  const activated: string[] = [];
  const blocked: string[] = [];
  for (const s of seeds) {
    const row = bySlug.get(s.slug);
    if (!row) continue;
    if (row.requiresDpia) {
      if (!approved.has(row.requiresDpia)) approved.set(row.requiresDpia, await check(tx, row.requiresDpia as DpiaKey));
      if (!approved.get(row.requiresDpia)) {
        blocked.push(`${row.slug}:${row.requiresDpia}`);
        continue;
      }
    }
    await tx.update(automations).set({ status: "active", activatedAt: now, updatedAt: now }).where(eq(automations.id, row.id));
    await tx.insert(auditLog).values({
      actor: { kind: "system", id: null },
      action: "automation.activate",
      entityType: "automation",
      entityId: row.id,
      oldValue: { status: "draft" },
      newValue: { status: "active", release },
      createdAt: now,
    });
    activated.push(row.slug);
  }
  return { activated, blocked };
}

// ---------------------------------------------------------------------------
// Release activation command (go-live step, N-1 of docs/build/seam-issues-r2.md)
// ---------------------------------------------------------------------------

/** The command's output: one line on stdout. */
const writeLine = (line: string): void => void process.stdout.write(`${line}\n`);

/** The releases `activateReleaseSequences` accepts, in order. */
export const ACTIVATION_RELEASES = ["R2", "R3"] as const satisfies readonly ActivationRelease[];

/** `R2` or `r2` -> `R2`; anything else throws with the accepted values. */
export function parseActivationRelease(arg: string | undefined): ActivationRelease {
  const value = (arg ?? "").trim().toUpperCase();
  const hit = ACTIVATION_RELEASES.find((r) => r === value);
  if (!hit) throw new Error(`release must be one of ${ACTIVATION_RELEASES.join(", ")} (got "${arg ?? ""}")`);
  return hit;
}

/** The lines the go-live command prints: what was switched on and what a DPIA still blocks. */
export function formatActivationReport(release: ActivationRelease, r: ActivateReleaseResult): string[] {
  const lines = [`${release}: ${r.activated.length} journey(s) activated${r.activated.length ? `: ${r.activated.join(", ")}` : ""}`];
  for (const b of r.blocked) {
    const [slug, dpia] = b.split(":");
    lines.push(`${release}: ${slug} stays draft until DPIA ${dpia} is approved`);
  }
  return lines;
}

/**
 * The body of the go-live command `release:activate <R>` (automation spec 3.6, decision 30):
 * runs `activateReleaseSequences` in one transaction of `db`, prints the report and returns it.
 * Idempotent: a second run activates nothing new. DPIA approval is read with ops' rule
 * (`dpia_records`), so a DPIA-gated journey activates on the first run after the approval.
 */
export async function runReleaseActivation(
  db: Db,
  release: ActivationRelease,
  opts: ActivateReleaseOptions & { log?: (line: string) => void } = {},
): Promise<ActivateReleaseResult> {
  const { log = writeLine, ...rest } = opts;
  const result = await db.transaction((tx) => activateReleaseSequences(tx, release, rest));
  for (const line of formatActivationReport(release, result)) log(line);
  return result;
}

/**
 * A command-line entry for the go-live step: `argv[0]` is the release. Connects with
 * `DATABASE_URL_UNPOOLED` (else `DATABASE_URL`) and `DATABASE_DRIVER` like `db:migrate`, runs
 * `runReleaseActivation` and returns the exit code (0 done, 1 refused or failed). See
 * `docs/runbooks/automations.md` ("Switching on a release's journeys").
 */
export async function releaseActivationCli(argv: readonly string[], log: (line: string) => void = writeLine): Promise<number> {
  let release: ActivationRelease;
  try {
    release = parseActivationRelease(argv[0]);
  } catch (err) {
    log(`release:activate: ${(err as Error).message}`);
    return 1;
  }
  const { createDbHandle } = await import("../client");
  const handle = await createDbHandle(undefined, process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL);
  try {
    await runReleaseActivation(handle.db, release, { log });
    return 0;
  } catch (err) {
    log(`release:activate ${release} failed: ${(err as Error).message}`);
    return 1;
  } finally {
    await handle.close();
  }
}

export const seed: DefaultSeed = {
  after: ["platform", "crm", "email"],
  run: async (db) => {
    await seedAutomationRows(db);
  },
};
