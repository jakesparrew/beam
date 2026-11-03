import { config } from "dotenv";

config({ path: ["../../.env.local", "../../.env"], quiet: true });

/**
 * Applies the committed migrations in ./migrations to the database in
 * DATABASE_URL_UNPOOLED (direct connection), falling back to DATABASE_URL.
 * DATABASE_DRIVER=pg (default) uses TCP; DATABASE_DRIVER=neon-ws uses Neon's
 * WebSocket driver (port 443) where TCP 5432 is blocked.
 */
async function main() {
  const driver = process.env.DATABASE_DRIVER ?? "pg";
  const url = process.argv[2] ?? process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL_UNPOOLED or DATABASE_URL must be set");
  const migrationsFolder = new URL("../migrations", import.meta.url).pathname;

  if (driver === "neon-ws") {
    const { Pool, neonConfig } = await import("@neondatabase/serverless");
    const { drizzle } = await import("drizzle-orm/neon-serverless");
    const { migrate } = await import("drizzle-orm/neon-serverless/migrator");
    neonConfig.webSocketConstructor = globalThis.WebSocket;
    const pool = new Pool({ connectionString: url, max: 1 });
    try {
      await migrate(drizzle({ client: pool }), { migrationsFolder });
    } finally {
      await pool.end();
    }
  } else if (driver === "pg") {
    const { Pool } = await import("pg");
    const { drizzle } = await import("drizzle-orm/node-postgres");
    const { migrate } = await import("drizzle-orm/node-postgres/migrator");
    const pool = new Pool({ connectionString: url, max: 1 });
    try {
      await migrate(drizzle({ client: pool }), { migrationsFolder });
    } finally {
      await pool.end();
    }
  } else {
    throw new Error(`db:migrate supports DATABASE_DRIVER=pg or neon-ws, got "${driver}"`);
  }
  const target = new URL(url.replace(/^postgres(ql)?:/, "http:"));
  console.log(`Migrations applied (${driver}) to ${target.hostname}${target.pathname}.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
