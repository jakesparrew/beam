/**
 * tsx applies a tsconfig's compilerOptions only to the files its `include` matches. With
 * `apps/web/tsconfig.json` the `.tsx` files of `packages/*` fell outside it and were compiled
 * with esbuild's classic JSX, so every email a script rendered (load test, demo seed) failed with
 * "React is not defined". Web scripts run tsx with `tsconfig.scripts.json`, which includes them.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;

describe("tsx scripts of the web app", () => {
  it("tsconfig.scripts.json includes the packages' .tsx files", () => {
    const cfg = readJson(path.join(root, "apps/web/tsconfig.scripts.json"));
    expect(cfg.extends).toBe("./tsconfig.json");
    expect(cfg.include).toContain("../../packages/*/src/**/*.tsx");
  });

  it("every root script that runs tsx in @beam/web passes tsconfig.scripts.json", () => {
    const scripts = readJson(path.join(root, "package.json")).scripts as Record<string, string>;
    const web = Object.entries(scripts).filter(([, cmd]) => /--filter @beam\/web exec tsx /.test(cmd));
    expect(web.length).toBeGreaterThan(0);
    for (const [name, cmd] of web) expect(`${name}: ${cmd}`).toContain("tsx --tsconfig tsconfig.scripts.json ");
  });
});
