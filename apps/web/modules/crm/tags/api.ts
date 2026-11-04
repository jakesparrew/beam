/** Tag api (crm spec 4.8), implemented by crm-P2. crm-P1 stub with the final signatures. */
import type { Tx } from "@beam/db";
import { NotImplementedError } from "@beam/core/errors";
import type { PersonTagSource } from "@beam/core/crm";
import type { EventCtx } from "../api";

const notYet = <T>(fn: string): Promise<T> => Promise.reject(new NotImplementedError(`crm.${fn}`));

export function applyTag(_tx: Tx, _ctx: EventCtx, _personId: string, _tagKey: string, _source: PersonTagSource): Promise<{ applied: boolean }> {
  return notYet("applyTag");
}

export function removeTag(_tx: Tx, _ctx: EventCtx, _personId: string, _tagKey: string): Promise<{ removed: boolean }> {
  return notYet("removeTag");
}
