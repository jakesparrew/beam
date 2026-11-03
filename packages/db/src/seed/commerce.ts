/**
 * commerce's `defaults` seed profile (runbook 3.4, BS-11). Wave 0 skeleton by platform-P7, with no
 * `seed` export yet, so `seedDefaults()` runs only the modules that seed something (platform's
 * `seed-platform.test.ts` expects exactly `["platform"]` in Wave 0). commerce adds, when it has system
 * rows to seed (idempotent, `on conflict do nothing`):
 *
 *   import type { DefaultSeed } from "./run";
 *   export const seed: DefaultSeed = { after: ["forms"], run: async (db, options) => { ... } };
 */
export {};
