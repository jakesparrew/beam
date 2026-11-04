import { describe, expect, it } from "vitest";
import { readStoredUtm, UTM_STORAGE_KEY, utmFromSearch } from "./utm";

const store = (value: string | null) => ({ getItem: (k: string) => (k === UTM_STORAGE_KEY ? value : null) });

describe("client-safe UTM helpers (fix-w09-site-review, forms-P4 request)", () => {
  it("reads the stored landing, and null for nothing, malformed or blocked storage", () => {
    expect(readStoredUtm(store(JSON.stringify({ utm: { source: "nb" }, landingPath: "/nl/actie" })))).toEqual({ utm: { source: "nb" }, landingPath: "/nl/actie" });
    expect(readStoredUtm(store(null))).toBeNull();
    expect(readStoredUtm(store("{not json"))).toBeNull();
    expect(readStoredUtm(store(JSON.stringify({ utm: {} })))).toBeNull();
    expect(
      readStoredUtm({
        getItem: () => {
          throw new Error("SecurityError");
        },
      }),
    ).toBeNull();
    expect(readStoredUtm(null)).toBeNull();
    // Outside a browser the default storage is absent.
    expect(readStoredUtm()).toBeNull();
  });

  it("keeps only utm_* values of at most 200 characters", () => {
    expect(utmFromSearch(`?utm_source=nb&utm_medium=mail&foo=1&utm_term=${"x".repeat(201)}`)).toEqual({ source: "nb", medium: "mail" });
  });
});
