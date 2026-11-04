// @vitest-environment jsdom
/**
 * fix-w09-site-review, requests served for other packages: `api.ts` re-exports `getPageKindByPath`
 * (forms rule A2 branch 7) and the client-safe `readStoredUtm` (forms-P4), and the "Website"
 * section nav links the WordPress import (site-P7).
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import * as core from "@beam/core/site";

afterEach(() => cleanup());

describe("site api re-exports", () => {
  it("exposes getPageKindByPath from server/refs and readStoredUtm from @beam/core/site", async () => {
    const api = await import("./api");
    const refs = await import("./server/refs");
    const utm = await import("./ui/public/utm-capture");
    expect(api.getPageKindByPath).toBe(refs.getPageKindByPath);
    expect(api.readStoredUtm).toBe(core.readStoredUtm);
    expect(utm.readStoredUtm).toBe(core.readStoredUtm);
    expect(api.UTM_STORAGE_KEY).toBe("beam_utm");
    sessionStorage.setItem("beam_utm", JSON.stringify({ utm: { campaign: "spring" }, landingPath: "/nl/actie" }));
    expect(core.readStoredUtm()).toEqual({ utm: { campaign: "spring" }, landingPath: "/nl/actie" });
    sessionStorage.clear();
    expect(core.readStoredUtm()).toBeNull();
  });
});

describe("SiteSectionNav", () => {
  it("links the WordPress import section and marks it current", async () => {
    const { SiteSectionNav } = await import("./ui/admin/pages-table");
    const L = { "nav.website": "Website", "nav.pages": "Pages", "nav.navigation": "Navigation", "nav.media": "Media", "nav.redirects": "Redirects", "nav.imports": "WordPress import", "nav.settings": "Settings" };
    render(<SiteSectionNav L={L} current="/admin/site/imports" />);
    const link = screen.getByRole("link", { name: "WordPress import" });
    expect(link.getAttribute("href")).toBe("/admin/site/imports");
    expect(link.getAttribute("aria-current")).toBe("page");
  });
});
