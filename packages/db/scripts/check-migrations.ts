export {};
/**
 * Fails when the TypeScript schema has changes that no committed migration
 * covers. Run `pnpm db:generate` to create the missing migration.
 */
const { generateDrizzleJson, generateMigration } = await import("drizzle-kit/api");
const schema = await import("../src/schema/index");
const { latestSnapshot } = await import("../src/testing");

const previous = latestSnapshot() ?? generateDrizzleJson({}, undefined, undefined, "snake_case");
const current = generateDrizzleJson(
  schema as Record<string, unknown>,
  (previous as { id: string }).id,
  undefined,
  "snake_case",
);
const pending = await generateMigration(previous as never, current);
if (pending.length) {
  console.error(`Schema has ${pending.length} statement(s) not covered by a committed migration:\n`);
  console.error(pending.join("\n"));
  console.error("\nRun: pnpm db:generate");
  process.exit(1);
}
console.log("Migrations are in sync with the schema.");
