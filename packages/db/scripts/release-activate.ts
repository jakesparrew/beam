/**
 * `pnpm release:activate <R2|R3>`: switches on the seeded journeys of a release at its go-live
 * (activateReleaseSequences through releaseActivationCli; see docs/runbooks/automations.md,
 * "Switching on a release's journeys", and docs/runbooks/go-live.md). Uses DATABASE_URL_UNPOOLED
 * or DATABASE_URL. Journeys whose DPIA is not approved stay draft and are listed as blocked.
 */
import { releaseActivationCli } from "../src/seed/automation";

releaseActivationCli(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`release:activate: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  },
);
