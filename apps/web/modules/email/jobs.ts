/**
 * email jobs. Facade read by `pnpm gen:indexes`. Written by platform-P7 on behalf of the email
 * module (platform spec 4.9); email-P1 takes the file over in Wave 1.
 *
 * Wave 0 `email.send`: looks the template key up in the generated `TEMPLATE_REGISTRY`, renders
 * it with `renderEmail()`, applies `EMAIL_SINK` (rewrites `to`), stores the HTML as a
 * `rendered_email` file outside production, loads `attachments` with `readFile()`, passes them,
 * `replyTo` and the headers to the Resend client (the fake under `INTEGRATIONS=fake`), and sets
 * `resend_id`, `sent_at` and status `sent`. A message that is no longer `queued` is left alone,
 * so a second run sends nothing. Suppression, consent and webhooks are email's Wave 1 work.
 */
import { z } from "zod";
import { emailMessages } from "@beam/db/schema";
import { PermanentError } from "@beam/core/errors";
import { isLocale } from "@beam/core/i18n";
import { renderEmail } from "@beam/email/render";
import { TEMPLATE_REGISTRY } from "@beam/email/templates/registry";
import type { TemplateDef } from "@beam/email/templates/define";
import type { EmailAttachment } from "@beam/integrations/resend";
import { eq } from "@/lib/ctx";
import { readFile, storeFile } from "@/lib/files";
import { appEnv } from "@/lib/integrations";
import { defineJob, type JobCtx } from "@/lib/job-runner";
import { getSetting } from "@/lib/settings";

/** Rendered copies are swept after 30 days (`platform.files_rendered_email`). */
const RENDERED_TTL_MS = 30 * 86_400_000;

const SendInput = z.object({ emailMessageId: z.string().uuid(), template: z.string().min(1) });

function templateFor(key: string): TemplateDef {
  const def = (TEMPLATE_REGISTRY as Readonly<Record<string, TemplateDef | undefined>>)[key];
  if (!def) throw new PermanentError(`unknown_template: ${key}`);
  return def;
}

export async function sendEmailMessage(ctx: JobCtx, input: z.infer<typeof SendInput>): Promise<{ status: string; resendId: string | null }> {
  const [message] = await ctx.tx.select().from(emailMessages).where(eq(emailMessages.id, input.emailMessageId));
  if (!message) throw new PermanentError(`email_message_not_found: ${input.emailMessageId}`);
  if (message.status !== "queued") return { status: message.status, resendId: message.resendId };
  const template = templateFor(input.template);
  if (!isLocale(message.locale)) throw new PermanentError(`invalid_locale: ${message.locale}`);
  if (!message.toEmail) throw new PermanentError("email_recipient_missing");

  const rendered = await renderEmail(template, { locale: message.locale, props: message.props ?? {} });
  const sink = process.env.EMAIL_SINK?.trim();
  const to = sink || message.toEmail;

  let renderedFileId: string | null = message.renderedFileId;
  if (appEnv() !== "production") {
    const stored = await storeFile(ctx, {
      kind: "rendered_email",
      name: `${input.template}-${message.id}.html`,
      mime: "text/html",
      bytes: new TextEncoder().encode(rendered.html),
      expiresAt: new Date(ctx.now.getTime() + RENDERED_TTL_MS),
      ...(message.personId ? { personId: message.personId } : {}),
    });
    renderedFileId = stored.fileId;
  }

  const attachments: EmailAttachment[] = [];
  for (const a of message.attachments) {
    const file = await readFile(ctx.tx, a.fileId);
    if (!file) throw new PermanentError(`attachment_not_found: ${a.fileId}`);
    attachments.push({ filename: a.filename, content: file.bytes, contentType: file.mime, ...(a.inline ? { inline: true } : {}) });
  }

  const config = await getSetting(ctx.tx, "email_config");
  const { id: resendId } = await ctx.integrations.resend.sendEmail({
    from: config.senders.transactional,
    to,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    replyTo: message.replyTo ?? config.senders.reply_to,
    headers: { ...(message.extraHeaders ?? {}) },
    ...(attachments.length ? { attachments } : {}),
    idempotencyKey: `email:${message.id}`,
  });

  await ctx.tx
    .update(emailMessages)
    .set({ status: "sent", resendId, sentAt: ctx.now, subject: rendered.subject, renderedFileId, updatedAt: ctx.now })
    .where(eq(emailMessages.id, message.id));
  return { status: "sent", resendId };
}

export const jobs = [defineJob({ kind: "email.send", lane: "fast", priority: 1, input: SendInput, run: sendEmailMessage })];
