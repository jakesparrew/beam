/**
 * email's cross-module door. Forward stub written by platform-P5 (runbook DR-10): platform's
 * magic link, invite, reset and report emails call `sendTransactional`. platform-P7 rewrites
 * this file with the working Wave 0 version and keeps this export unchanged.
 */
import { NotImplementedError } from "@beam/core/errors";
import type { Locale } from "@beam/core/i18n";
import type { Ctx } from "@/lib/ctx";

/** email spec 4.8: the full input shape, so Wave 1 callers type-check against the stub. */
export type SendTransactionalInput = {
  template: string;
  personId?: string;
  to?: string;
  locale: Locale;
  data: Record<string, unknown>;
  key: string;
  attachments?: { fileId: string; filename: string; inline?: boolean }[];
  context?: Record<string, string>;
  sendAt?: Date;
  replyTo?: string;
  headers?: { "In-Reply-To"?: string; References?: string };
};

export function sendTransactional(ctx: Ctx, input: SendTransactionalInput): Promise<{ emailMessageId: string; jobId: string }> {
  void ctx;
  void input;
  return Promise.reject(new NotImplementedError("email.sendTransactional"));
}
