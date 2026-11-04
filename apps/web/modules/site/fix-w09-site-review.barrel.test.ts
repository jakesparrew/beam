/**
 * fix-w09-site-review (attempt 2): `api.ts` re-exports `getPageKindByPath` from `server/page-kind`,
 * not from `server/refs`. Refs imports forms' and webinar's api barrels, and loading them from
 * site's barrel closes an import cycle (forms and commerce import site's api) that made other
 * modules' `vi.mock("@/modules/site/api", ...)` factories bind the real terms functions (booking's
 * order-hooks and guests tests failed with terms_required).
 */
import { describe, expect, it, vi } from "vitest";

const loaded = vi.hoisted(() => ({ forms: false, webinar: false }));

vi.mock("@/modules/forms/api", async (orig) => {
  loaded.forms = true;
  return orig();
});
vi.mock("@/modules/webinar/api", async (orig) => {
  loaded.webinar = true;
  return orig();
});

describe("site api barrel", () => {
  it("does not load forms or webinar when imported", async () => {
    const api = await import("./api");
    const pageKind = await import("./server/page-kind");
    expect(api.getPageKindByPath).toBe(pageKind.getPageKindByPath);
    expect(loaded).toEqual({ forms: false, webinar: false });
  });

  it("server/refs still re-exports the same getPageKindByPath", async () => {
    const refs = await import("./server/refs");
    const pageKind = await import("./server/page-kind");
    expect(refs.getPageKindByPath).toBe(pageKind.getPageKindByPath);
  });
});
