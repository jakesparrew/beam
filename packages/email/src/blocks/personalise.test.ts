import { describe, expect, it } from "vitest";
import { personalise, tokenNames } from "./personalise";

describe("personalise", () => {
  it("HTML-escapes values and fallbacks in HTML, not in plain text", () => {
    const values = { first_name: "Ann & <Bo>" };
    expect(personalise("<p>Hi {{first_name}}</p>", values, { escape: true })).toBe("<p>Hi Ann &amp; &lt;Bo&gt;</p>");
    expect(personalise("Hi {{first_name}}", values, { escape: false })).toBe("Hi Ann & <Bo>");
    expect(personalise("Hi {{ last_name | l'ami }}", {}, { escape: true })).toBe("Hi l&#39;ami");
  });

  it("uses the fallback for a missing or null value", () => {
    expect(personalise("Hi {{first_name|friend}}", {}, { escape: false })).toBe("Hi friend");
    expect(personalise("Hi {{first_name|friend}}", { first_name: null }, { escape: false })).toBe("Hi friend");
    expect(personalise("Hallo {{first_name|vriend}}, je hebt {{credits_remaining|geen}} beurten", { credits_remaining: 4 }, { escape: false })).toBe(
      "Hallo vriend, je hebt 4 beurten",
    );
  });

  it("an empty value uses the fallback, and without one renders nothing", () => {
    expect(personalise("Hi {{first_name|friend}}", { first_name: "" }, { escape: true })).toBe("Hi friend");
    expect(personalise("Hi {{first_name}}!", { first_name: "" }, { escape: true })).toBe("Hi !");
    expect(personalise("Hi {{first_name}}!", {}, { escape: true })).toBe("Hi !");
  });

  it("does not escape a fallback twice when the compiler already escaped it", () => {
    expect(personalise('<a href="{{portal_url|https://beam.be/?a=1&amp;b=2}}">x</a>', {}, { escape: true })).toBe('<a href="https://beam.be/?a=1&amp;b=2">x</a>');
  });

  it("leaves a merge-field placeholder for the resolver when it has no value yet", () => {
    const html = "<p>{{webinar.title|our webinar}} starts {{webinar.starts_at_local}}; {{first_name|friend}}</p>";
    const first = personalise(html, { first_name: "Ann" }, { escape: true });
    expect(first).toBe("<p>{{webinar.title|our webinar}} starts {{webinar.starts_at_local}}; Ann</p>");
    const second = personalise(first, { "webinar.title": null, "webinar.starts_at_local": "3 Dec 19:00" }, { escape: true });
    expect(second).toBe("<p>our webinar starts 3 Dec 19:00; Ann</p>");
  });

  it("leaves text that is not a token shape untouched", () => {
    expect(personalise("{{ Not A Token }} and {{}}", {}, { escape: true })).toBe("{{ Not A Token }} and {{}}");
  });

  it("lists token and merge-field names", () => {
    expect(tokenNames("{{first_name}} {{webinar.title}} {{first_name|x}} {{bad name}}")).toEqual({ tokens: ["first_name"], mergeFields: ["webinar.title"] });
  });
});
