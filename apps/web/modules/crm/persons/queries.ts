/** Person queries (crm spec 4.3), implemented by crm-P2. crm-P1 stubs with the final names and inputs. */
import type { DbOrTx } from "@beam/db";
import { NotImplementedError } from "@beam/core/errors";
import type { AcquisitionSource, PersonStatus } from "@beam/core/crm";
import type { Locale } from "@beam/core/i18n";

export type PersonListRow = {
  id: string;
  customerNumber: string;
  name: string;
  email: string | null;
  status: PersonStatus;
  isOverridden: boolean;
  isMember: boolean;
  tags: string[];
  lastActivityAt: Date | null;
  createdAt: Date;
};

export function listPersons(
  _tx: DbOrTx,
  _input: {
    q?: string;
    status?: PersonStatus;
    tagIds?: string[];
    segmentId?: string;
    locale?: Locale;
    source?: AcquisitionSource;
    isTester?: boolean;
    page: number;
    pageSize: number;
    sort: "created_at" | "last_name" | "last_activity_at";
  },
): Promise<{ rows: PersonListRow[]; total: number }> {
  return Promise.reject(new NotImplementedError("crm.listPersons"));
}

/** Command palette: customer number, email, `phone_e164`, then the name prefix (`search_tsv`). */
export function searchPersons(_tx: DbOrTx, _q: string, _limit = 10): Promise<PersonListRow[]> {
  return Promise.reject(new NotImplementedError("crm.searchPersons"));
}
