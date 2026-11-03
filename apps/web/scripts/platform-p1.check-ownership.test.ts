import { describe, expect, it } from "vitest";
import { covers, foreignPaths } from "./check-ownership";

// Self-test of check-ownership.ts with a fake diff (platform spec section 12, P1 tests).
const owns = [
  "apps/web/modules/crm/actions.ts",
  "apps/web/modules/crm/ui/**",
  "apps/web/app/[locale]/(portal)/account/page.tsx",
  "packages/core/src/crm/{index, types}.ts",
  "packages/db/src/schema/crm.ts",
];

describe("check-ownership", () => {
  it("accepts owned paths, globs, literal route brackets and brace lists", () => {
    expect(covers("apps/web/modules/crm/ui/**", "apps/web/modules/crm/ui/person/card.tsx")).toBe(true);
    expect(covers("apps/web/app/[locale]/(portal)/account/page.tsx", "apps/web/app/[locale]/(portal)/account/page.tsx")).toBe(true);
    expect(covers("packages/core/src/crm/{index, types}.ts", "packages/core/src/crm/types.ts")).toBe(true);
    expect(covers("packages/core/src/crm/{index, types}.ts", "packages/core/src/crm/merge.ts")).toBe(false);
  });

  it("lists every foreign path of a fake diff and allows generated, dependency-request and BS-23 files", () => {
    const diff = [
      "apps/web/modules/crm/actions.ts",
      "apps/web/modules/crm/ui/person/card.tsx",
      "packages/core/src/crm/index.ts",
      "apps/web/registry/jobs.generated.ts",
      "packages/db/src/schema/index.ts",
      "docs/build/dependency-requests/crm-P3.md",
      "apps/web/modules/crm/crm-p3.merge.test.ts",
      "apps/web/modules/booking/actions.ts",
      "packages/db/src/schema/booking.ts",
      "docs/build/dependency-requests/crm-P4.md",
      "apps/web/modules/booking/crm-p3.test.ts",
      "package.json",
    ];
    expect(foreignPaths("crm-P3", owns, diff)).toEqual([
      "apps/web/modules/booking/actions.ts",
      "packages/db/src/schema/booking.ts",
      "docs/build/dependency-requests/crm-P4.md",
      "apps/web/modules/booking/crm-p3.test.ts",
      "package.json",
    ]);
  });
});
