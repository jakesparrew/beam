/**
 * platform-P12 route seam (PL-95, gap G11): every V1 URL that `e2e/acceptance-v1.spec.ts` visits
 * resolves through `resolveRoute` to a `page.tsx` under `apps/web/app/` (route groups skipped,
 * `[locale]` and `[id]` matched); the three booking portal URLs resolve to booking-P6's files with
 * `loading.tsx` and `error.tsx` in their own folder; no `page.tsx`, `layout.tsx` or `route.ts`
 * exists anywhere under `apps/web/modules/`. A fixture tree proves the resolver itself.
 *
 * The second half checks the two runtime rules unit tests cannot see (CONVENTIONS item 12,
 * OD-18): a `"use server"` file exports only async functions, and code without `"use client"`
 * never calls React `createContext`/`useContext` (server components, route handlers and jobs
 * import it, and React has no context on the server).
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { APP_DIR, assertRoutes, checkRoutes, relativeFile, resolveRoute, type RequiredRoute } from "./support/route-map";

const here = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(here, "..");
const REPO = path.resolve(WEB, "../..");
const UUID = "3f0c8f9e-2b1a-4c7d-9e8f-1a2b3c4d5e6f";
const UUID2 = "7d4e2c1b-9a8f-4e3d-8c2b-6f5e4d3c2b1a";

/**
 * The V1 URLs of the acceptance spec, with the package that owns each page (ownership.json).
 * `docs/plan/acceptance-v1.md` names the checklist row of each.
 */
const V1_ROUTES: RequiredRoute[] = [
  // Public site and portal sign-in
  { url: "/nl", owner: "site-P2" },
  { url: `/nl/events/${UUID}`, owner: "site-P2" },
  { url: "/nl/account/login", owner: "platform-P6" },
  { url: "/nl/account/login/check-email", owner: "platform-P6" },
  { url: "/nl/account/login/verify?token=x", owner: "platform-P6" },
  // Shop, checkout and package balance
  { url: "/nl/account/shop", owner: "commerce-P5" },
  { url: "/nl/account/shop/PKG-5-DAYS", owner: "commerce-P5" },
  { url: "/nl/account/checkout?checkout=abc", owner: "commerce-P5" },
  { url: `/nl/account/checkout/${UUID}`, owner: "commerce-P5" },
  { url: `/nl/account/checkout/return/${UUID}`, owner: "commerce-P5" },
  { url: "/nl/account/packages", owner: "credits-P7" },
  // Booking, cancel and reschedule (G11: these three must be real pages under the portal shell)
  { url: `/nl/account/book/${UUID}`, owner: "booking-P6" },
  { url: "/nl/account/bookings", owner: "booking-P6", needs: ["loading", "error"] },
  { url: `/nl/account/bookings/${UUID}`, owner: "booking-P6", needs: ["loading", "error"] },
  { url: `/nl/account/bookings/${UUID}/reschedule`, owner: "booking-P6", needs: ["loading", "error"] },
  // Waitlist claim, preferences, forms, privacy
  { url: "/nl/claim/token-abc", owner: "booking-P5" },
  { url: "/nl/preferences/token-abc", owner: "crm-P3" },
  { url: "/nl/f/recovery-check", owner: "forms-P4" },
  { url: "/fr/f/recovery-check", owner: "forms-P4" },
  { url: "/nl/account/privacy", owner: "ops-P5" },
  // Staff back office
  { url: "/admin/login", owner: "platform-P6" },
  { url: "/admin/mfa/verify", owner: "platform-P6" },
  { url: `/admin/bookings/${UUID}`, owner: "booking-P4" },
  { url: `/admin/persons/${UUID}`, owner: "crm-P7" },
  { url: "/admin/reports/revenue?period=day", owner: "ops-P3" },
  { url: "/admin/reports/exports", owner: "ops-P6" },
  { url: `/admin/privacy/new?personId=${UUID}`, owner: "ops-P5" },
  { url: `/admin/privacy/${UUID}`, owner: "ops-P5" },
  { url: "/admin/imports/new", owner: "ops-P4" },
  { url: `/admin/imports/${UUID}`, owner: "ops-P4" },
  { url: `/admin/email/messages/${UUID}`, owner: "email-P7" },
  { url: `/admin/templates/${UUID}/preview?locale=nl-BE&as=member`, owner: "email-P5" },
];

/** Route handlers the spec calls (fake provider page, health): `route.ts`, not pages. */
const V1_HANDLERS = [
  { url: `/api/dev/fake-pay/${UUID}`, file: "app/api/dev/fake-pay/[id]/route.ts" },
  { url: "/api/health", file: "app/api/health/route.ts" },
  { url: "/api/public/unsubscribe/token-abc", file: "app/api/public/unsubscribe/[token]/route.ts" },
];

type Ownership = Record<string, { owns?: string[] }>;
const ownership = JSON.parse(readFileSync(path.join(REPO, "docs/build/ownership.json"), "utf8")) as Ownership;
const ownersOf = (repoPath: string) =>
  Object.entries(ownership)
    .filter(([, v]) => (v.owns ?? []).includes(repoPath))
    .map(([k]) => k);

describe("V1 routes (PL-95)", () => {
  it("every V1 URL the acceptance spec visits resolves to a page under apps/web/app", () => {
    expect(checkRoutes(V1_ROUTES)).toEqual([]);
    expect(() => assertRoutes(V1_ROUTES)).not.toThrow();
  });

  it("each page belongs to the package the route list names", () => {
    const wrong: string[] = [];
    for (const route of V1_ROUTES) {
      const found = resolveRoute(route.url);
      if (!found) continue; // reported by the test above
      const repoPath = `apps/web/${relativeFile(found.file)}`;
      const owners = ownersOf(repoPath);
      // Only flag a file that ownership.json assigns to other packages entirely.
      const module = route.owner.split("-")[0]!;
      if (owners.length > 0 && !owners.some((o) => o === route.owner || o.startsWith(`${module}-`) || o.startsWith(`fix-`))) {
        wrong.push(`${route.url} -> ${repoPath} owned by ${owners.join(", ")}, expected ${route.owner}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("the three booking portal URLs resolve to booking-P6's files with loading and error beside each (G11)", () => {
    const expected = [
      ["/nl/account/bookings", "app/[locale]/(portal)/account/bookings/page.tsx", {}],
      [`/nl/account/bookings/${UUID}`, "app/[locale]/(portal)/account/bookings/[id]/page.tsx", { id: UUID }],
      [`/nl/account/bookings/${UUID2}/reschedule`, "app/[locale]/(portal)/account/bookings/[id]/reschedule/page.tsx", { id: UUID2 }],
    ] as const;
    for (const [url, file, params] of expected) {
      const found = resolveRoute(url);
      expect(found, url).not.toBeNull();
      expect(relativeFile(found!.file)).toBe(file);
      expect(found!.params).toEqual({ locale: "nl", ...params });
      expect(ownersOf(`apps/web/${file}`)).toContain("booking-P6");
    }
    expect(checkRoutes(V1_ROUTES.filter((r) => r.owner === "booking-P6" && r.needs))).toEqual([]);
  });

  it("the route handlers the spec calls resolve to their route.ts", () => {
    for (const { url, file } of V1_HANDLERS) expect(relativeFile(resolveRoute(url)!.file), url).toBe(file);
  });

  it("a locale outside nl, fr and en does not match [locale]", () => {
    expect(resolveRoute("/de/account/bookings")?.file ?? null).toBeNull();
    expect(resolveRoute("/fr/account/bookings")!.params.locale).toBe("fr");
  });

  it("no page.tsx, layout.tsx or route.ts exists under apps/web/modules (G11, PL-93)", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) {
          if (name !== "node_modules") walk(full);
        } else if (/^(page|layout|route|loading|error|template|default|not-found)\.(tsx|ts|jsx|js)$/.test(name)) {
          offenders.push(path.relative(WEB, full));
        }
      }
    };
    walk(path.join(WEB, "modules"));
    expect(offenders).toEqual([]);
  });
});

describe("resolveRoute on a fixture tree", () => {
  let root: string;
  let app: string;
  const touch = (rel: string) => {
    const file = path.join(root, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "export default function Page() { return null; }\n");
  };

  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), "beam-route-map-"));
    app = path.join(root, "app");
    touch("app/page.tsx");
    touch("app/[locale]/(portal)/account/bookings/[id]/page.tsx");
    touch("app/[locale]/(portal)/account/bookings/[id]/loading.tsx");
    touch("app/[locale]/(portal)/account/bookings/new/page.tsx");
    touch("app/[locale]/(portal)/account/bookings/page.tsx");
    touch("app/[locale]/(site)/[[...path]]/page.tsx");
    touch("app/[locale]/(site)/docs/[...slug]/page.tsx");
    touch("app/[locale]/(site)/_private/page.tsx");
    touch("app/(admin)/admin/(nested)/reports/page.tsx");
    touch("app/(admin)/admin/[section]/page.tsx");
    touch("app/api/things/[id]/route.ts");
    // Reachable only through apps/web/modules: never a route.
    touch("modules/booking/bookings/page.tsx");
    touch("modules/booking/bookings/[id]/page.tsx");
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("resolves (portal)/account/bookings/[id]/page.tsx for /fr/account/bookings/abc", () => {
    const found = resolveRoute("/fr/account/bookings/abc", app);
    expect(relativeFile(found!.file, app)).toBe("app/[locale]/(portal)/account/bookings/[id]/page.tsx");
    expect(found!.params).toEqual({ locale: "fr", id: "abc" });
  });

  it("prefers a static segment over a dynamic one", () => {
    expect(relativeFile(resolveRoute("/en/account/bookings/new", app)!.file, app)).toBe("app/[locale]/(portal)/account/bookings/new/page.tsx");
    expect(relativeFile(resolveRoute("/admin/reports", app)!.file, app)).toBe("app/(admin)/admin/(nested)/reports/page.tsx");
    expect(resolveRoute("/admin/other", app)!.params).toEqual({ section: "other" });
  });

  it("falls back to a catch-all, and the optional catch-all matches zero segments", () => {
    expect(resolveRoute("/nl/docs/a/b", app)!.params).toEqual({ locale: "nl", slug: "a/b" });
    expect(relativeFile(resolveRoute("/nl", app)!.file, app)).toBe("app/[locale]/(site)/[[...path]]/page.tsx");
    expect(resolveRoute("/nl/some/cms/page", app)!.params).toEqual({ locale: "nl", path: "some/cms/page" });
    // The account folder has no page at /nl/account itself: the CMS catch-all answers.
    expect(relativeFile(resolveRoute("/nl/account", app)!.file, app)).toBe("app/[locale]/(site)/[[...path]]/page.tsx");
  });

  it("returns null for a path only reachable through apps/web/modules", () => {
    expect(resolveRoute("/booking/bookings", app)).toBeNull();
    expect(resolveRoute("/modules/booking/bookings/abc", app)).toBeNull();
    expect(resolveRoute("/de/account/bookings", app)).toBeNull();
  });

  it("ignores private folders, keeps route handlers and strips query strings and hashes", () => {
    expect(resolveRoute("/nl/_private", app)!.params).toEqual({ locale: "nl", path: "_private" });
    expect(relativeFile(resolveRoute("/api/things/7?x=1#y", app)!.file, app)).toBe("app/api/things/[id]/route.ts");
    expect(relativeFile(resolveRoute("http://localhost:3100/", app)!.file, app)).toBe("app/page.tsx");
  });

  it("assertRoutes names the owner of a missing page and of a missing loading or error file", () => {
    const routes: RequiredRoute[] = [
      { url: "/nl/account/bookings/abc", owner: "booking-P6", needs: ["loading", "error"] },
      { url: "/booking/bookings", owner: "booking-P6" },
      { url: "/api/things/1", owner: "platform-P5" },
    ];
    expect(checkRoutes(routes, app)).toEqual([
      "/nl/account/bookings/abc: no error.tsx beside app/[locale]/(portal)/account/bookings/[id]/page.tsx (owner booking-P6)",
      "no page for /booking/bookings (owner booking-P6)",
      "/api/things/1 resolves to app/api/things/[id]/route.ts, not a page (owner platform-P5)",
    ]);
    expect(() => assertRoutes(routes, app)).toThrow(/no page for \/booking\/bookings \(owner booking-P6\)/);
  });
});

// ---------------------------------------------------------------------------------------------
// Runtime rules the tests cannot see (CONVENTIONS item 12, OD-18)
// ---------------------------------------------------------------------------------------------

const SOURCE_ROOTS = [path.join(WEB, "app"), path.join(WEB, "modules"), path.join(WEB, "lib"), ...["core", "email", "ui", "integrations", "db"].map((p) => path.join(REPO, "packages", p, "src"))];

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) {
        if (name !== "node_modules" && !name.startsWith(".")) walk(full);
      } else if (/\.(ts|tsx)$/.test(name) && !/\.(test|spec)\.(ts|tsx)$/.test(name) && !name.endsWith(".d.ts") && !/fixtures?\.ts$/.test(name)) {
        out.push(full);
      }
    }
  };
  SOURCE_ROOTS.forEach(walk);
  return out;
}

const parse = (file: string) => ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);

function directive(sf: ts.SourceFile): string | null {
  const first = sf.statements[0];
  if (first && ts.isExpressionStatement(first) && ts.isStringLiteral(first.expression)) return first.expression.text;
  return null;
}

const hasModifier = (node: ts.Node, kind: ts.SyntaxKind) => (ts.canHaveModifiers(node) ? (ts.getModifiers(node) ?? []).some((m) => m.kind === kind) : false);

/** Exports of a "use server" file that are not (or may not be) async functions. */
function nonFunctionExports(sf: ts.SourceFile): string[] {
  const bad: string[] = [];
  for (const st of sf.statements) {
    if (ts.isExportDeclaration(st)) {
      if (st.isTypeOnly) continue;
      if (!st.exportClause) bad.push("export * (re-exports everything)");
      continue;
    }
    if (ts.isExportAssignment(st)) continue; // export default <expr>: checked by Next at runtime
    if (!hasModifier(st, ts.SyntaxKind.ExportKeyword)) continue;
    if (ts.isFunctionDeclaration(st)) {
      if (!hasModifier(st, ts.SyntaxKind.AsyncKeyword)) bad.push(`function ${st.name?.text ?? "?"} is not async`);
      continue;
    }
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        const name = d.name.getText(sf);
        const init = d.initializer;
        if (!init) {
          bad.push(`${name} has no value`);
          continue;
        }
        const e = ts.isAsExpression(init) || ts.isSatisfiesExpression(init) ? init.expression : init;
        if ((ts.isArrowFunction(e) || ts.isFunctionExpression(e)) && hasModifier(e, ts.SyntaxKind.AsyncKeyword)) continue;
        // `action(...)` and similar wrappers return the async function Next needs.
        if (ts.isCallExpression(e)) continue;
        bad.push(`${name} is not an async function`);
      }
      continue;
    }
    if (ts.isTypeAliasDeclaration(st) || ts.isInterfaceDeclaration(st)) continue;
    bad.push(`${ts.SyntaxKind[st.kind]} export`);
  }
  return bad;
}

/** Calls of `createContext` / `useContext` (also as `React.createContext`), comments ignored. */
function contextCalls(sf: ts.SourceFile): string[] {
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : "";
      if (name === "createContext" || name === "useContext") {
        found.push(`${name} at line ${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

describe("runtime rules (CONVENTIONS 12, OD-18)", () => {
  const files = sourceFiles().map((f) => ({ file: f, sf: parse(f) }));

  it("finds the source files and the use server files", () => {
    expect(files.length).toBeGreaterThan(100);
    expect(files.filter((f) => directive(f.sf) === "use server").length).toBeGreaterThan(0);
  });

  it('a "use server" file exports only async functions', () => {
    const problems = files
      .filter((f) => directive(f.sf) === "use server")
      .flatMap((f) => nonFunctionExports(f.sf).map((p) => `${path.relative(REPO, f.file)}: ${p}`));
    expect(problems).toEqual([]);
  });

  it('code without "use client" never calls React createContext or useContext', () => {
    const problems = files
      .filter((f) => directive(f.sf) !== "use client")
      .flatMap((f) => contextCalls(f.sf).map((p) => `${path.relative(REPO, f.file)}: ${p}`));
    expect(problems).toEqual([]);
  });

  it("the checks catch the two OD-18 defects", () => {
    const src = (text: string) => ts.createSourceFile("x.tsx", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    expect(nonFunctionExports(src(`"use server";\nexport const LIMIT = 5;\nexport const run = action(schema, async () => 1);\nexport async function go() {}\nexport type T = 1;`))).toEqual([
      "LIMIT is not an async function",
    ]);
    expect(nonFunctionExports(src(`"use server";\nexport function sync() {}\nexport * from "./x";\nexport const o = { a: 1 };`))).toEqual([
      "function sync is not async",
      "export * (re-exports everything)",
      "o is not an async function",
    ]);
    expect(contextCalls(src(`// createContext() in a comment\nimport { createContext } from "react";\nexport const C = createContext(null);\nconst v = React.useContext(C);`))).toEqual([
      "createContext at line 3",
      "useContext at line 4",
    ]);
  });

  it("the app tree is where resolveRoute looks", () => {
    expect(APP_DIR).toBe(path.join(WEB, "app"));
  });
});
