/** Tag queries (crm spec 4.3), implemented by crm-P2. crm-P1 stub. */
import type { DbOrTx } from "@beam/db";
import { NotImplementedError } from "@beam/core/errors";
import type { LocalizedText } from "@beam/core/i18n";

export type TagRow = { id: string; key: string; name: LocalizedText; color: string; description: string | null; isSystem: boolean; count: number };

export function listTags(_tx: DbOrTx): Promise<TagRow[]> {
  return Promise.reject(new NotImplementedError("crm.listTags"));
}
