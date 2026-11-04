/** Timeline query for the 360 page (crm spec 4.3, rule 3.37), implemented by crm-P7. crm-P1 stub. */
import type { DbOrTx } from "@beam/db";
import { NotImplementedError } from "@beam/core/errors";
import type { TimelineCategory, TimelinePage } from "@beam/core/crm";

export function getTimeline(
  _tx: DbOrTx,
  _input: { personId?: string; companyId?: string; before?: { occurredAt: Date; id: string }; categories?: TimelineCategory[]; limit?: number },
): Promise<TimelinePage> {
  return Promise.reject(new NotImplementedError("crm.getTimeline"));
}
