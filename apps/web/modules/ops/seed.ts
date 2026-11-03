/**
 * ops's demo seed (runbook 6.3), run by `apps/web/scripts/seed-demo.ts` in `after` order. Facade
 * read by `pnpm gen:indexes`. Wave 0 skeleton by platform-P7: ops adds its demo rows in Wave 1.
 */
export const seed = { after: ["automation"], run: (): Promise<void> => Promise.resolve() };
