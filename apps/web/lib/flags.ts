/**
 * Feature flags (PL-43, PL-44). Keys are declared in modules' `config.ts` (`flags`), so an
 * unknown key fails typecheck. A declared flag without a row is `off`; a row whose key is no
 * longer declared is ignored. Resolved flag rows and tester lookups are cached 60 s per server
 * instance. Flags are resolved on the server only.
 */
import { featureFlags, persons, users } from "@beam/db/schema";
import { isFlagOn, type FlagRow } from "@beam/core/platform";
import type { FlagKey } from "../registry/types.generated";
import { eq, getAppDb, type Actor } from "./ctx";

export const FLAG_CACHE_MS = 60_000;

export type FlagDefinition = { key: string; description: string };

let registry: Promise<Readonly<Record<string, FlagDefinition | undefined>>> | undefined;
function loadFlags(): Promise<Readonly<Record<string, FlagDefinition | undefined>>> {
  registry ??= import("../registry/flags.generated").then(
    (m) => (m as { FLAGS?: unknown }).FLAGS as Readonly<Record<string, FlagDefinition | undefined>>,
  );
  return registry;
}

type Cached<T> = { value: T; at: number };
const rows = new Map<string, Cached<FlagRow | null>>();
const testers = new Map<string, Cached<boolean>>();

/** Empties the 60 s caches (tests; `updateFlag` calls it on the instance that saved). */
export function clearFlagCache(): void {
  rows.clear();
  testers.clear();
}

function fresh<T>(c: Cached<T> | undefined): c is Cached<T> {
  return !!c && Date.now() - c.at < FLAG_CACHE_MS;
}

async function flagRow(key: string): Promise<FlagRow | null> {
  const hit = rows.get(key);
  if (fresh(hit)) return hit.value;
  const db = await getAppDb();
  const found = await db
    .select({ state: featureFlags.state, userIds: featureFlags.userIds, personIds: featureFlags.personIds })
    .from(featureFlags)
    .where(eq(featureFlags.key, key))
    .limit(1);
  const value = found[0] ?? null;
  rows.set(key, { value, at: Date.now() });
  return value;
}

async function isTester(kind: "user" | "person", id: string): Promise<boolean> {
  const cacheKey = `${kind}:${id}`;
  const hit = testers.get(cacheKey);
  if (fresh(hit)) return hit.value;
  const db = await getAppDb();
  const found =
    kind === "user"
      ? await db.select({ t: users.isTester }).from(users).where(eq(users.id, id)).limit(1)
      : await db.select({ t: persons.isTester }).from(persons).where(eq(persons.id, id)).limit(1);
  const value = found[0]?.t ?? false;
  testers.set(cacheKey, { value, at: Date.now() });
  return value;
}

/** True when `key` is on for `actor` (state `on`, or `testers` and the actor is a tester or listed). */
export async function flag(key: FlagKey, actor: Actor): Promise<boolean> {
  const def = (await loadFlags())[key];
  if (!def) return false;
  const row = await flagRow(key);
  if (!row || row.state === "off") return false;
  if (row.state === "on") return true;
  if (actor.kind === "staff") {
    return isFlagOn(row, { userId: actor.userId, userIsTester: await isTester("user", actor.userId) });
  }
  if (actor.kind === "customer") {
    return isFlagOn(row, {
      userId: actor.userId,
      personId: actor.personId,
      userIsTester: await isTester("user", actor.userId),
      personIsTester: await isTester("person", actor.personId),
    });
  }
  return false;
}
