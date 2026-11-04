/**
 * finance's `defaults` seed profile (runbook 3.4, BS-11, finance-P1): the `finance` settings row
 * with empty issuer fields (register court, IBAN, BIC), the general-terms footer and the voucher
 * VAT note in the three locales (`FINANCE_SETTING_DEFAULT`). Idempotent (`on conflict do
 * nothing`): a value edited in `/admin/settings/finance` is never overwritten. Platform seeds
 * the `company` key and ops seeds the finance retention rows; demo invoices are demo data in
 * `apps/web/modules/finance/seed.ts`.
 */
import { FINANCE_SETTING_DEFAULT } from "@beam/core/finance";
import type { DbOrTx } from "../client";
import { settings } from "../schema/platform";
import type { DefaultSeed } from "./run";

async function run(db: DbOrTx): Promise<void> {
  await db
    .insert(settings)
    .values({ key: "finance", value: FINANCE_SETTING_DEFAULT })
    .onConflictDoNothing({ target: settings.key });
}

export const seed: DefaultSeed = { after: ["platform"], run };
