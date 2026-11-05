/** forms-P7: the ImportMapping JsonPath (rule I2). */
import { describe, expect, it } from "vitest";
import { ImportMapping } from "@beam/core/forms";
import { parsePath, resolvePath, setPath } from "./json-path";

const typeform = {
  event_id: "01H",
  form_response: {
    hidden: { email: "a@example.com" },
    answers: [
      { type: "number", number: 7, field: { id: "x1", ref: "stress" } },
      { type: "number", number: 5, field: { id: "x2", ref: "sleep" } },
      { type: "choice", choice: { label: "Often" }, field: { id: "x3", ref: "movement" } },
    ],
    tags: ["a", "b"],
  },
};

describe("I2: resolvePath", () => {
  it("I2: answers[field.ref=sleep].number", () => {
    expect(resolvePath(typeform, "form_response.answers[field.ref=sleep].number")).toBe(5);
    expect(resolvePath(typeform, "form_response.answers[field.ref=movement].choice.label")).toBe("Often");
  });

  it("I2: keys, indexes and a whole sub-object", () => {
    expect(resolvePath(typeform, "event_id")).toBe("01H");
    expect(resolvePath(typeform, "form_response.hidden.email")).toBe("a@example.com");
    expect(resolvePath(typeform, "form_response.tags[1]")).toBe("b");
    expect(resolvePath(typeform, "form_response.answers[0].field")).toEqual({ id: "x1", ref: "stress" });
  });

  it("I2: a path that does not match gives undefined, never throws", () => {
    expect(resolvePath(typeform, "form_response.answers[field.ref=nope].number")).toBeUndefined();
    expect(resolvePath(typeform, "form_response.tags[9]")).toBeUndefined();
    expect(resolvePath(typeform, "event_id.deeper")).toBeUndefined();
    expect(resolvePath(typeform, "form_response.hidden[0]")).toBeUndefined();
    expect(resolvePath(null, "a")).toBeUndefined();
    expect(resolvePath("text", "length")).toBeUndefined();
    expect(resolvePath({ a: 1 }, "constructor")).toBeUndefined();
  });

  it("I2: invalid paths parse to null (same grammar as the mapping schema)", () => {
    for (const bad of ["", "a..b", ".a", "a.", "[0]", "a[", "a[x]", "a[=1]", "a.[0]", "a b"]) {
      expect(parsePath(bad), bad).toBeNull();
      expect(resolvePath(typeform, bad)).toBeUndefined();
    }
    for (const good of ["a", "a.b[0].c", "form_response.answers[field.ref=sleep].number", "$x-y"]) {
      expect(parsePath(good), good).not.toBeNull();
      expect(ImportMapping.safeParse({ email: good, externalId: "id", answers: {} }).success, good).toBe(true);
    }
  });
});

describe("I5: setPath rebuilds a CSV row", () => {
  it("sets nested keys and indexes, refuses filters and collisions", () => {
    const o: Record<string, unknown> = {};
    expect(setPath(o, "lead.email", "a@example.com")).toBe(true);
    expect(setPath(o, "answers[1]", "x")).toBe(true);
    expect(setPath(o, "score", "72")).toBe(true);
    expect(o).toEqual({ lead: { email: "a@example.com" }, answers: [undefined, "x"], score: "72" });
    expect(setPath(o, "score.deeper", 1)).toBe(false);
    expect(setPath(o, "answers[field.ref=a]", 1)).toBe(false);
    expect(setPath(o, "not a path", 1)).toBe(false);
    expect(resolvePath(o, "lead.email")).toBe("a@example.com");
  });
});
