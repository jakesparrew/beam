/**
 * Identity api (crm spec 4.8), implemented by crm-P2. crm-P1 stub with the final signatures:
 * each throws `NotImplementedError('crm.<fn>')` until crm-P2 lands. Re-exported by
 * `apps/web/modules/crm/api.ts`.
 */
import type { DbOrTx, Tx } from "@beam/db";
import { NotImplementedError } from "@beam/core/errors";
import type { Locale } from "@beam/core/i18n";
import type { Acquisition, ImportPersonRow, PersonFieldPatch, PersonStatus, PersonSummary } from "@beam/core/crm";
import type { EventCtx } from "../api";

const notYet = <T>(fn: string): Promise<T> => Promise.reject(new NotImplementedError(`crm.${fn}`));

export function findOrCreatePersonByEmail(
  _tx: Tx,
  _ctx: EventCtx,
  _input: {
    email: string;
    firstName?: string;
    lastName?: string;
    phone?: string;
    locale: Locale;
    acquisition?: Omit<Acquisition, "captured_at">;
    isTester?: boolean;
  },
): Promise<{ personId: string; created: boolean }> {
  return notYet("findOrCreatePersonByEmail");
}

/** Walk-ins and guests without email. */
export function createPersonWithoutEmail(
  _tx: Tx,
  _ctx: EventCtx,
  _input: { firstName: string; lastName?: string; phone?: string; locale: Locale; acquisition: Omit<Acquisition, "captured_at"> },
): Promise<{ personId: string }> {
  return notYet("createPersonWithoutEmail");
}

/** Follows merges. */
export function getPerson(_tx: DbOrTx, _personId: string): Promise<PersonSummary | null> {
  return notYet("getPerson");
}

export function resolveCanonicalPersonId(_tx: DbOrTx, _personId: string): Promise<string> {
  return notYet("resolveCanonicalPersonId");
}

export function resolvePersonIds(_tx: DbOrTx, _personId: string): Promise<string[]> {
  return notYet("resolvePersonIds");
}

export function getPersonStatus(
  _tx: DbOrTx,
  _personId: string,
): Promise<{ status: PersonStatus; derivedStatus: PersonStatus; override: PersonStatus | null; hasActiveMembership: boolean }> {
  return notYet("getPersonStatus");
}

/** `source: 'automation'` writes `data.source = 'automation'` on the event. */
export function setStatusOverride(
  _tx: Tx,
  _ctx: EventCtx,
  _input: { personId: string; status: PersonStatus | null; reason: string; onlyIfUnset?: boolean; source?: "manual" | "automation" },
): Promise<{ applied: boolean }> {
  return notYet("setStatusOverride");
}

export function upsertPersonFromImport(
  _tx: Tx,
  _ctx: EventCtx,
  _row: ImportPersonRow,
  _importId: string,
): Promise<{ personId: string; outcome: "created" | "updated" | "unchanged" }> {
  return notYet("upsertPersonFromImport");
}

/** ops privacy, in the same transaction as `processing_restrictions`. */
export function restrictProcessing(_tx: Tx, _ctx: EventCtx, _personId: string, _restricted: boolean): Promise<void> {
  return notYet("restrictProcessing");
}

/** ops retention `ops.marketing_profile` (all) and `ops.marketing_contact` (`leadsOnly`). */
export function listInactiveProfiles(_tx: DbOrTx, _cutoff: Date, _limit: number, _filter?: { leadsOnly?: boolean }): Promise<string[]> {
  return notYet("listInactiveProfiles");
}

/** booking, commerce POS, platform pickers; `limit` default 10, max 50. */
export function searchPersons(
  _tx: DbOrTx,
  _input: { q: string; limit?: number },
): Promise<Array<{ personId: string; customerNumber: string; name: string; email: string | null; status: PersonStatus }>> {
  return notYet("searchPersons");
}

/** The one write path for person columns (cross-module D13); never email, locale or acquisition. */
export function updatePersonFields(
  _tx: Tx,
  _ctx: EventCtx,
  _personId: string,
  _patch: PersonFieldPatch,
  _opts: { onlyEmpty: boolean },
): Promise<{ changed: string[] }> {
  return notYet("updatePersonFields");
}

/** forms rule A3, when the person already existed without a source. */
export function fillAcquisitionIfEmpty(
  _tx: Tx,
  _ctx: EventCtx,
  _personId: string,
  _acquisition: Omit<Acquisition, "captured_at">,
): Promise<{ applied: boolean }> {
  return notYet("fillAcquisitionIfEmpty");
}

export function getPersonPrefill(
  _tx: DbOrTx,
  _personId: string,
): Promise<{
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  locale: Locale;
  birthOn: string | null;
  postalCode: string | null;
  city: string | null;
}> {
  return notYet("getPersonPrefill");
}

/** automation suppression exit; includes merged rows. */
export function findPersonIdsByEmailHash(_tx: DbOrTx, _emailHash: string): Promise<string[]> {
  return notYet("findPersonIdsByEmailHash");
}

/** platform flags. */
export function setPersonTester(_tx: Tx, _ctx: EventCtx, _input: { personId: string; isTester: boolean }): Promise<void> {
  return notYet("setPersonTester");
}
