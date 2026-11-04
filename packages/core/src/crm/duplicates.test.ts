import { describe, expect, it } from "vitest";
import { DUPLICATE_MIN_SCORE, DUPLICATE_SCORES, orderPair, scorePair, type DupInput } from "./duplicates";

const base: DupInput = { email: null, phoneE164: null, firstName: null, lastName: null, birthOn: null, postalCode: null, externalIds: {} };
const person = (over: Partial<DupInput>): DupInput => ({ ...base, ...over });

describe("duplicate scores (rule 3.28)", () => {
  it("3.28 same legacy external id scores 95", () => {
    expect(scorePair(person({ externalIds: { simplybook: "981" } }), person({ externalIds: { simplybook: "981" } }))).toEqual({ score: 95, reasons: ["external_id"] });
    expect(scorePair(person({ externalIds: { simplybook: "981" } }), person({ externalIds: { mailchimp: "981" } })).score).toBe(0);
  });

  it("3.28 same gmail address after removing dots and +tag scores 90", () => {
    expect(scorePair(person({ email: "ann.peeters+spa@gmail.com" }), person({ email: "annpeeters@googlemail.com" }))).toEqual({ score: 90, reasons: ["email_variant"] });
    expect(scorePair(person({ email: "ann.peeters@example.com" }), person({ email: "annpeeters@example.com" })).score).toBe(0);
  });

  it("3.28 same phone_e164 scores 80", () => {
    expect(scorePair(person({ phoneE164: "+32470123456" }), person({ phoneE164: "+32470123456" }))).toEqual({ score: 80, reasons: ["phone"] });
  });

  it("3.28 same lower-cased name and birth date scores 70", () => {
    expect(scorePair(person({ firstName: "Ann", lastName: "Peeters", birthOn: "1990-04-02" }), person({ firstName: " ann", lastName: "PEETERS", birthOn: "1990-04-02" }))).toEqual({
      score: 70,
      reasons: ["name_birth"],
    });
    expect(scorePair(person({ firstName: "Ann", lastName: "Peeters", birthOn: "1990-04-02" }), person({ firstName: "Ann", lastName: "Peeters", birthOn: "1991-04-02" })).score).toBe(0);
  });

  it("3.28 same name and postal code scores 50, the minimum stored score", () => {
    const r = scorePair(person({ firstName: "Ann", lastName: "Peeters", postalCode: "9000" }), person({ firstName: "Ann", lastName: "Peeters", postalCode: "9000" }));
    expect(r).toEqual({ score: 50, reasons: ["name_postal"] });
    expect(r.score).toBe(DUPLICATE_MIN_SCORE);
  });

  it("3.28 scores of several reasons do not add up: the maximum counts", () => {
    const a = person({ email: "a.b@gmail.com", phoneE164: "+32470123456", firstName: "A", lastName: "B", birthOn: "1990-01-01", postalCode: "9000" });
    const b = person({ email: "ab@gmail.com", phoneE164: "+32470123456", firstName: "a", lastName: "b", birthOn: "1990-01-01", postalCode: "9000" });
    const r = scorePair(a, b);
    expect(r.score).toBe(DUPLICATE_SCORES.email_variant);
    expect(r.reasons).toEqual(["email_variant", "phone", "name_birth", "name_postal"]);
  });

  it("3.28 missing values never match", () => {
    expect(scorePair(person({}), person({}))).toEqual({ score: 0, reasons: [] });
    expect(scorePair(person({ firstName: "Ann" }), person({ firstName: "Ann" })).score).toBe(0);
  });

  it("orders a pair so that person_a_id < person_b_id", () => {
    const x = "b0000000-0000-4000-8000-000000000000";
    const y = "a0000000-0000-4000-8000-000000000000";
    expect(orderPair(x, y)).toEqual([y, x]);
    expect(orderPair(y, x)).toEqual([y, x]);
  });
});
