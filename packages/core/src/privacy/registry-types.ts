/**
 * The privacy registration every module declares in `apps/web/modules/<m>/privacy.ts`
 * (collected into `registry/privacy.generated.ts` as `GDPR_REGISTRY`; ops runs it).
 *
 * `@beam/core` may not import the database client, so the transaction type is a type
 * parameter: `apps/web` uses `PrivacyRegistration<Tx>`. The handlers are declared with
 * method syntax so an implementation may annotate its own `tx` type.
 */

/** One row of ops' `retention_policies`, seeded with `on conflict (key) do nothing`. */
export type RetentionPolicySeed = {
  /** `<module>.<name>` (Convention 4), also the key of the module's `sweep` map. */
  key: string;
  tableName: string;
  /** `null` exactly when `action = 'keep'`. */
  days: number | null;
  action: "anonymise" | "delete" | "keep";
  description: string;
  runOrder?: number;
  batchSize?: number;
};

export type EraseAction = "deleted" | "anonymised" | "redacted" | "unlinked" | "kept" | "none";

/** What an erase handler did to one table; counts and actions only, never values. */
export type EraseReportRow = { table: string; rows: number; action: EraseAction | (string & {}) };

export type PrivacyExport = Record<string, unknown>;

export interface PrivacyRegistration<TTx = unknown> {
  /** Every table of the module that holds a person reference. */
  tables: readonly string[];
  /** The subject's data, one entry per table or topic (GDPR articles 15 and 20). */
  export(tx: TTx, personId: string): Promise<PrivacyExport>;
  /** Deletes or anonymises the subject's rows; runs under `SET LOCAL beam.allow_rewrite = 'on'`. */
  erase(tx: TTx, personId: string): Promise<EraseReportRow[]>;
  /** Retention sweep per policy key: deletes or anonymises rows older than `cutoff`, returns the count. */
  sweep?: Record<string, (tx: TTx, cutoff: Date) => Promise<number>>;
  /** The module's retention policy rows. */
  retention?: readonly RetentionPolicySeed[];
}

/** Checks the `days`/`action` invariant of a retention seed (`days` null exactly when `keep`). */
export function isValidRetentionSeed(seed: RetentionPolicySeed): boolean {
  if (!/^[a-z]+\.[a-z0-9_]+$/.test(seed.key)) return false;
  if (seed.action === "keep") return seed.days === null;
  return seed.days !== null && Number.isInteger(seed.days) && seed.days > 0;
}
