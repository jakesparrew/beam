import { describe, expect, it } from "vitest";
import { localeFromPrefix, localePath, prefixFromLocale } from "./locales";
import { isLegacyGone, isReservedPath, isValidPagePath, LEGACY_GONE_PREFIXES, normalisePath, parseStableEventPath, pathIssue, RESERVED_SEGMENTS, slugifySegment } from "./paths";

const UUID = "3f0c1a52-6b1e-4c3e-9a51-2d7e8f9a0b1c";

describe("normalisePath", () => {
  it.each([
    ["/over-ons/", "/over-ons"],
    ["over-ons", "/over-ons"],
    ["/Over-Ons/Team/", "/over-ons/team"],
    ["//nl//blog///", "/nl/blog"],
    ["/", "/"],
    ["", "/"],
    ["/?p=123", "/?p=123"],
    ["/?page_id=45&utm_source=x", "/?page_id=45"],
    ["/blog/?utm_campaign=y&p=7#top", "/blog?p=7"],
    ["/?page_id=45&p=12", "/?p=12&page_id=45"],
    ["https://www.beam.be/Over-Ons/?ref=x", "/over-ons"],
  ])("%s -> %s", (raw, expected) => {
    expect(normalisePath(raw)).toBe(expected);
  });
});

describe("reserved paths", () => {
  it.each(RESERVED_SEGMENTS)("first segment %s is reserved", (segment) => {
    expect(isReservedPath(segment)).toBe(true);
    expect(isReservedPath(`${segment}/sub`)).toBe(true);
    const expected = /^[a-z0-9]+(-[a-z0-9]+)*$/.test(segment) ? "path_reserved" : "path_invalid";
    expect(pathIssue(segment, "standard")).toBe(expected);
  });

  it("events/<uuid> is reserved and parsed as a stable event link; the events index is not", () => {
    expect(isReservedPath(`events/${UUID}`)).toBe(true);
    expect(isReservedPath("events")).toBe(false);
    expect(isReservedPath("events/summer-night")).toBe(false);
    expect(parseStableEventPath(["events", UUID])).toBe(UUID);
    expect(parseStableEventPath(["events", UUID.toUpperCase()])).toBe(UUID);
    expect(parseStableEventPath(["events", "summer-night"])).toBeNull();
    expect(parseStableEventPath(["events", UUID, "x"])).toBeNull();
    expect(parseStableEventPath(["blog", UUID])).toBeNull();
  });

  it("other first segments are free", () => {
    expect(isReservedPath("over-ons")).toBe(false);
    expect(isReservedPath("accounts")).toBe(false);
  });
});

describe("legacy gone prefixes", () => {
  it.each(LEGACY_GONE_PREFIXES)("%s answers gone with and without the locale prefix", (prefix) => {
    expect(isLegacyGone(prefix)).toBe(true);
    expect(isLegacyGone(`/nl${prefix}`)).toBe(true);
    expect(isLegacyGone(`/fr${prefix}/sub/page`)).toBe(true);
  });

  it("does not match lookalikes or normal pages", () => {
    expect(isLegacyGone("/nl/wp-adminx")).toBe(false);
    expect(isLegacyGone("/nl/over-ons")).toBe(false);
    expect(isLegacyGone("/nl")).toBe(false);
  });
});

describe("pathIssue", () => {
  it("accepts up to 3 segments and refuses a 4th", () => {
    expect(pathIssue("a/b/c", "standard")).toBeNull();
    expect(pathIssue("a/b/c/d", "standard")).toBe("path_invalid");
  });

  it("checks the segment grammar and length", () => {
    expect(pathIssue("Over-Ons", "standard")).toBe("path_invalid");
    expect(pathIssue("over--ons", "standard")).toBe("path_invalid");
    expect(pathIssue("over-ons/", "standard")).toBe("path_invalid");
    expect(pathIssue("x".repeat(60), "standard")).toBeNull();
    expect(pathIssue("x".repeat(61), "standard")).toBe("path_invalid");
    expect(isValidPagePath("dagen/sauna-dag")).toBe(true);
  });

  it("only home uses the empty path and home uses only the empty path", () => {
    expect(pathIssue("", "home")).toBeNull();
    expect(pathIssue("home", "home")).toBe("path_home_only");
    expect(pathIssue("", "standard")).toBe("path_home_only");
    expect(pathIssue(undefined, "standard")).toBe("path_missing");
  });

  it("refuses reserved first segments", () => {
    expect(pathIssue("account", "standard")).toBe("path_reserved");
    expect(pathIssue("checkout/x", "landing")).toBe("path_reserved");
    expect(pathIssue(`events/${UUID}`, "event")).toBe("path_reserved");
  });

  it("slugifies free text", () => {
    expect(slugifySegment("Été à la Plage!")).toBe("ete-a-la-plage");
  });
});

describe("locale prefixes", () => {
  it("maps one to one", () => {
    expect(localeFromPrefix("nl")).toBe("nl-BE");
    expect(localeFromPrefix("fr")).toBe("fr-BE");
    expect(localeFromPrefix("en")).toBe("en");
    expect(prefixFromLocale("fr-BE")).toBe("fr");
    expect(localePath("nl-BE", "")).toBe("/nl");
    expect(localePath("en", "events")).toBe("/en/events");
  });
});
