import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDbHandle } from "@beam/db";
import { config } from "dotenv";

const here = path.dirname(fileURLToPath(import.meta.url));

/** The owner account the demo seed creates (runbook section 6, BS-20). */
export const DEMO_OWNER_EMAIL = "owner@demo.beam.be";

/** Throws unless the environment is a safe target for end-to-end runs (A9). */
export function assertSafeE2eEnv(env: NodeJS.ProcessEnv): void {
  const url = env.DATABASE_URL ?? "";
  if (/\/neondb(\?|$)/.test(url) || !/\/beam_dev(\?|$)/.test(url)) {
    throw new Error("e2e refuses to run: DATABASE_URL must name the beam_dev database (never neondb).");
  }
  if (env.INTEGRATIONS !== "fake") {
    throw new Error("e2e refuses to run: INTEGRATIONS must be 'fake'.");
  }
  if (env.APP_ENV === "production") {
    throw new Error("e2e refuses to run with APP_ENV=production.");
  }
}

export default async function globalSetup(): Promise<void> {
  config({ path: [path.join(here, "../../../.env.local"), path.join(here, "../../../.env")], quiet: true });
  assertSafeE2eEnv(process.env);

  const handle = await createDbHandle();
  try {
    const result: unknown = await handle.db.execute(
      `select 1 as found from users where lower(email) = '${DEMO_OWNER_EMAIL}' limit 1`,
    );
    // node-postgres and the Neon pool both return `{ rows }`.
    const rows = (result as { rows?: unknown[] }).rows ?? [];
    if (rows.length === 0) {
      throw new Error(`The demo seed has not run (${DEMO_OWNER_EMAIL} is missing): run pnpm seed:demo.`);
    }
  } finally {
    await handle.close();
  }
}
