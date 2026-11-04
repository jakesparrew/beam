/** Customer 360 query (crm spec 4.3, 5.1), implemented by crm-P7. crm-P1 stub. */
import type { DbOrTx } from "@beam/db";
import { NotImplementedError } from "@beam/core/errors";
import type { PersonStatus } from "@beam/core/crm";

export type Person360 = {
  /** Set when the requested id was merged: the page redirects to the winner. */
  redirectTo: string | null;
  person: { id: string; customerNumber: string; name: string; email: string | null; phone: string | null; locale: string; version: number };
  status: { status: PersonStatus; derivedStatus: PersonStatus; override: PersonStatus | null; isMember: boolean };
};

export function getPerson360(_tx: DbOrTx, _personId: string): Promise<Person360 | null> {
  return Promise.reject(new NotImplementedError("crm.getPerson360"));
}
