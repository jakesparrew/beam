/**
 * booking api, area `webinar` (R2, booking spec R64 and 4.9): the one `sessions` row of a webinar.
 * Typed stubs by booking-P1 with the final signatures of cross-module D50; booking-P8
 * implements them. There is no `linkWebinarSession`.
 */
import type { Tx } from "@beam/db";
import { NotImplementedError } from "@beam/core/errors";
import type { LocalizedText } from "@beam/core/i18n";
import type { Ctx } from "@/lib/ctx";

/** Creates or updates the webinar's session (kind `event`, category `webinar`, 0 seats); `sessionId` must match. */
export function upsertWebinarSession(
  _tx: Tx,
  _ctx: Ctx,
  _input: { webinarId: string; sessionId?: string; title: LocalizedText; startsAt: Date; endsAt: Date },
): Promise<{ sessionId: string; created: boolean }> {
  return Promise.reject(new NotImplementedError("booking.upsertWebinarSession"));
}

/** Cancels the webinar's session by `webinarId` (idempotent); `{ cancelled: false }` when none exists. */
export function cancelWebinarSession(_tx: Tx, _ctx: Ctx, _input: { webinarId: string; reason: string }): Promise<{ cancelled: boolean }> {
  return Promise.reject(new NotImplementedError("booking.cancelWebinarSession"));
}
