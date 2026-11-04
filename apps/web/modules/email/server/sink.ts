/**
 * `EMAIL_SINK` (email spec rule 43, edge case 17). Outside production (`APP_ENV !==
 * 'production'`) every recipient is rewritten to `EMAIL_SINK`, the subject names the real
 * address, and the rendered HTML is stored in `files` (kind `rendered_email`, 30 days) linked by
 * `email_messages.rendered_file_id`.
 *
 * A missing `EMAIL_SINK` outside production fails the send permanently (`email_sink_missing`)
 * whenever the Resend client is the real one (runbook 1.5 selection: a key present and
 * `INTEGRATIONS` not `fake`, or staging). With the fake client nothing can leave the machine, so
 * a local run without a sink sends to the fake as before (decision of email-P3).
 */
import { PermanentError } from "@beam/core/errors";
import { appEnv, integrationMode, PROVIDER_KEYS, type Env } from "@/lib/integrations";
import { storeFile } from "@/lib/files";
import type { Ctx } from "@/lib/ctx";

/** Rendered copies are swept after 30 days (`platform.files_rendered_email`). */
export const RENDERED_TTL_MS = 30 * 86_400_000;

export type SinkDecision = { production: true } | { production: false; sink: string | null; env: string };

export function sinkDecision(env: Env = process.env): SinkDecision {
  const mode = appEnv(env);
  if (mode === "production") return { production: true };
  const sink = env.EMAIL_SINK?.trim() || null;
  if (!sink && integrationMode("resend", PROVIDER_KEYS.resend, env) === "real") throw new PermanentError("email_sink_missing");
  return { production: false, sink, env: mode };
}

/** Stores the rendered HTML outside production; returns the file id. */
export async function storeRenderedCopy(ctx: Ctx, input: { messageId: string; templateKey: string; html: string; personId: string | null }): Promise<string> {
  const stored = await storeFile(ctx, {
    kind: "rendered_email",
    name: `${input.templateKey}-${input.messageId}.html`,
    mime: "text/html",
    bytes: new TextEncoder().encode(input.html),
    expiresAt: new Date(ctx.now.getTime() + RENDERED_TTL_MS),
    ...(input.personId ? { personId: input.personId } : {}),
  });
  return stored.fileId;
}
