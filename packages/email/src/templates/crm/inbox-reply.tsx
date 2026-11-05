/**
 * `crm.inbox_reply` (crm rule 3.50, section 6): a staff reply to an email or web-form thread of
 * the unified inbox. The body is the staff member's plain text, one paragraph per blank-line
 * block. Copy: `crm.email.inbox_reply.<slot>`. The send passes Reply-To `hello@beam.be` and the
 * thread's `In-Reply-To` and `References`, so the reply threads in the customer's mail client.
 */
import { z } from "zod";
import { EmailLayout, EmailText } from "../../layout";
import type { TemplateComponentProps } from "../define";

export const InboxReplyProps = z.object({
  body: z.string().min(1).max(20_000),
  /** The thread subject (the subject slot is `Re: {subject}`). */
  subject: z.string().min(1).max(500),
});

export const inboxReplySlots = {
  subject: "crm.email.inbox_reply.subject",
  preheader: "crm.email.inbox_reply.preheader",
  footer: "crm.email.inbox_reply.footer",
} as const;

/** The reply's paragraphs: blank lines split, single newlines stay inside a paragraph. */
export function replyParagraphs(body: string): string[] {
  return body
    .replace(/\r\n?/g, "\n")
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
}

export function InboxReply({ body, copy, locale }: TemplateComponentProps<typeof InboxReplyProps>) {
  return (
    <EmailLayout locale={locale} preheader={copy.preheader} footer={copy.footer}>
      {replyParagraphs(body).map((p, i) => (
        <EmailText key={i}>
          {p.split("\n").map((line, j, all) => (
            <span key={j}>
              {line}
              {j < all.length - 1 ? <br /> : null}
            </span>
          ))}
        </EmailText>
      ))}
    </EmailLayout>
  );
}
