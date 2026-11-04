import { describe, expect, it } from "vitest";
import { isSensitiveKey, SECRET_KEY_PATTERN, SENSITIVE_FIELD_KEYS } from "../privacy/sensitive-keys";
import { EMAIL_TOKENS, escapeHtml, parseTokens, renderTokens, unknownTokens } from "./tokens";

describe("personalisation tokens", () => {
  it("lists exactly the ten tokens of rule 23", () => {
    expect([...EMAIL_TOKENS].sort()).toEqual(
      [
        "credits_remaining",
        "first_name",
        "full_name",
        "last_name",
        "membership_period_end_on",
        "next_booking_at",
        "portal_url",
        "preferences_url",
        "status",
        "unsubscribe_url",
      ].sort(),
    );
  });

  it("parses tokens with positions and kinds", () => {
    const uses = parseTokens("Hi {{first_name}}, see {{webinar.title}} at {{ portal_url }}.");
    expect(uses.map((u) => [u.name, u.kind, u.fallback])).toEqual([
      ["first_name", "token", null],
      ["webinar.title", "merge_field", null],
      ["portal_url", "token", null],
    ]);
    expect(uses[0]).toMatchObject({ raw: "{{first_name}}", start: 3, end: 17 });
  });

  it("reads the fallback syntax, including an empty fallback and spaces", () => {
    const uses = parseTokens("{{first_name|vriend}} {{last_name | }} {{full_name|Chère cliente}}");
    expect(uses.map((u) => u.fallback)).toEqual(["vriend", "", "Chère cliente"]);
  });

  it("reports unknown tokens and unregistered merge fields; registered merge fields pass", () => {
    const text = "{{first_name}} {{favourite_colour}} {{webinar.title}} {{shop.discount}} {{Bad Name}} {{favourite_colour|x}}";
    expect(unknownTokens(text, ["webinar.title"])).toEqual(["favourite_colour", "shop.discount", "Bad Name"]);
    expect(parseTokens("{{Bad Name}}")[0]?.kind).toBe("invalid");
    expect(unknownTokens("Plain text without tokens")).toEqual([]);
  });

  it("renders values HTML-escaped, the fallback when missing, else an empty string", () => {
    const values: Record<string, string | null> = { first_name: "<Anna & Co>", last_name: null };
    const resolve = (name: string) => values[name];
    expect(renderTokens("Hi {{first_name}}!", resolve)).toBe("Hi &lt;Anna &amp; Co&gt;!");
    expect(renderTokens("Hi {{last_name|friend}}!", resolve)).toBe("Hi friend!");
    expect(renderTokens("Hi {{last_name}}!", resolve)).toBe("Hi !");
    expect(renderTokens("Hi {{first_name}}!", resolve, { escape: false })).toBe("Hi <Anna & Co>!");
    expect(escapeHtml(`"'`)).toBe("&quot;&#39;");
  });

  it("contains no sensitive column, special-category key or secret-like name", () => {
    const sensitiveColumns = ["value_enc", "data", "key_version"];
    for (const token of EMAIL_TOKENS) {
      expect(sensitiveColumns).not.toContain(token);
      expect((SENSITIVE_FIELD_KEYS as readonly string[]).includes(token)).toBe(false);
      expect(isSensitiveKey(token)).toBe(false);
      expect(SECRET_KEY_PATTERN.test(token)).toBe(false);
    }
  });
});
