/**
 * R3 inbox entry points for other modules (crm spec 4.8), implemented by crm-P9. crm-P1 stub
 * with the final signatures (moved from the Wave 0 `api.ts`).
 */
import type { Tx } from "@beam/db";
import { NotImplementedError } from "@beam/core/errors";
import type { EventCtx } from "../api";

const notYet = <T>(fn: string): Promise<T> => Promise.reject(new NotImplementedError(`crm.${fn}`));

export function ingestInboundEmail(
  _tx: Tx,
  _ctx: EventCtx,
  _msg: {
    messageId: string;
    inReplyTo?: string;
    from: string;
    fromName?: string;
    subject: string;
    text: string;
    attachmentCount: number;
    receivedAt: Date;
  },
): Promise<{ threadId: string }> {
  return notYet("ingestInboundEmail");
}

/** forms whose version sets `FormSettings.createInboxThread: true` (cross-module D62). */
export function createInboxThreadFromForm(
  _tx: Tx,
  _ctx: EventCtx,
  _input: { personId: string; submissionId: string; subject: string; body: string },
): Promise<{ threadId: string }> {
  return notYet("createInboxThreadFromForm");
}
