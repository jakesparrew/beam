import { config } from "dotenv";

config({ path: ["../../.env.local", "../../.env"], quiet: true });

/**
 * Applies the committed migrations in ./migrations.
 * Uses the direct connection over TCP when DATABASE_DRIVER=pg (default), and
 * Neon's HTTP driver when DATABASE_DRIVER=neon-http (no TCP port 5432 available).
 */
async function main() {
  const driver = process.env.DATABASE_DRIVER ?? "pg";
  const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL_UNPOOLED or DATABASE_URL must be set");
  const migrationsFolder = new URL("../migrations", import.meta.url).pathname;

  if (driver === "neon-http") {
    const { neon } = await import("@neondatabase/serverless");
    const { drizzle } = await import("drizzle-orm/neon-http");
    const { migrate } = await import("drizzle-orm/neon-http/migrator");
    await migrate(drizzle({ client: neon(url) }), { migrationsFolder });
  } else {
    const { Pool } = await import("pg");
    const { drizzle } = await import("drizzle-orm/node-postgres");
    const { migrate } = await import("drizzle-orm/node-postgres/migrator");
    const pool = new Pool({ connectionString: url, max: 1 });
    try {
      await migrate(drizzle({ client: pool }), { migrationsFolder });
    } finally {
      await pool.end();
    }
  }
  console.log(`Migrations applied (${driver}).`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
