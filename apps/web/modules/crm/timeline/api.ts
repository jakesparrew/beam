/** Timeline api (crm rules 3.35 to 3.37), implemented by crm-P7. crm-P1 stub with the final signature. */
import type { DbOrTx } from "@beam/db";
import { NotImplementedError } from "@beam/core/errors";
import type { TimelineCategory, TimelinePage } from "@beam/core/crm";

export function listTimeline(
  _tx: DbOrTx,
  _input: { personId?: string; companyId?: string; before?: { occurredAt: Date; id: string }; categories?: TimelineCategory[]; limit?: number },
): Promise<TimelinePage> {
  return Promise.reject(new NotImplementedError("crm.listTimeline"));
}
