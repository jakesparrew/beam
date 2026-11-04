import { describe, expect, it } from "vitest";
import { PermanentError } from "@beam/core/errors";
import { buildOutgoingEmail, LIST_UNSUBSCRIBE_POST, sinkSubject, type OutgoingMessage } from "./resend";

const MSG: OutgoingMessage = {
  messageId: "44444444-4444-4444-8444-444444444444",
  messageKind: "campaign",
  campaignId: "55555555-5555-4555-8555-555555555555",
  to: "customer1@example.com",
  subject: "Winter at BEAM",
  html: "<p>Hello</p>",
  text: "Hello",
};
const ONE_CLICK = { oneClickPostUrl: "https://beam.be/api/public/unsubscribe?t=tok123" };

describe("buildOutgoingEmail", () => {
  it("adds List-Unsubscribe and List-Unsubscribe-Post to marketing messages", () => {
    const out = buildOutgoingEmail(MSG, { kind: "marketing", from: "BEAM <news@news.beam.be>", replyTo: "info@beam.be", listUnsubscribe: ONE_CLICK });
    expect(out.headers).toEqual({ "List-Unsubscribe": `<${ONE_CLICK.oneClickPostUrl}>`, "List-Unsubscribe-Post": LIST_UNSUBSCRIBE_POST });
    expect(out).toMatchObject({ from: "BEAM <news@news.beam.be>", replyTo: "info@beam.be", to: "customer1@example.com", subject: "Winter at BEAM" });
    expect(out.tags).toEqual([
      { name: "message_id", value: MSG.messageId },
      { name: "kind", value: "campaign" },
      { name: "campaign_id", value: MSG.campaignId },
    ]);
  });

  it("refuses a marketing message without an https one-click URL", () => {
    expect(() => buildOutgoingEmail(MSG, { kind: "marketing", from: "x", replyTo: "y" })).toThrow(PermanentError);
    expect(() => buildOutgoingEmail(MSG, { kind: "marketing", from: "x", replyTo: "y", listUnsubscribe: { oneClickPostUrl: "mailto:unsubscribe@beam.be" } })).toThrow(
      /list_unsubscribe_not_https/,
    );
  });

  it("never puts List-Unsubscribe headers on transactional messages", () => {
    const msg = { ...MSG, messageKind: "transactional", campaignId: null, headers: { "List-Unsubscribe": "<https://x>", "X-Entity-Ref-ID": "abc" } };
    const out = buildOutgoingEmail(msg, { kind: "transactional", from: "BEAM <hello@mail.beam.be>", replyTo: "info@beam.be", listUnsubscribe: ONE_CLICK });
    expect(out.headers).toEqual({ "X-Entity-Ref-ID": "abc" });
    expect(out.tags?.map((t) => t.name)).toEqual(["message_id", "kind"]);
  });

  it("rewrites to the sink and prefixes the subject with the env and the real address", () => {
    const out = buildOutgoingEmail(MSG, {
      kind: "marketing",
      from: "BEAM <news@news.beam.be>",
      replyTo: "info@beam.be",
      listUnsubscribe: ONE_CLICK,
      sinkRewrite: { sink: "sink@demo.beam.be", env: "preview" },
    });
    expect(out.to).toBe("sink@demo.beam.be");
    expect(out.subject).toBe("[preview → customer1@example.com] Winter at BEAM");
    expect(sinkSubject("S", "dev", "a@example.com")).toBe("[dev → a@example.com] S");
    const plain = buildOutgoingEmail(MSG, { kind: "marketing", from: "x", replyTo: "y", listUnsubscribe: ONE_CLICK, sinkRewrite: null });
    expect(plain.to).toBe("customer1@example.com");
  });

  it("fails without a text part (rule 3) and keeps attachments for single sends", () => {
    expect(() => buildOutgoingEmail({ ...MSG, text: " " }, { kind: "transactional", from: "x", replyTo: "y" })).toThrow(/missing_text_part/);
    const pdf = { filename: "invoice.pdf", content: new Uint8Array([37, 80, 68, 70]), contentType: "application/pdf" };
    const out = buildOutgoingEmail({ ...MSG, attachments: [pdf] }, { kind: "transactional", from: "x", replyTo: "y" });
    expect(out.attachments).toEqual([pdf]);
    expect(buildOutgoingEmail(MSG, { kind: "transactional", from: "x", replyTo: "y" })).not.toHaveProperty("attachments");
  });
});
