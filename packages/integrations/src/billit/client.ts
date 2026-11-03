/**
 * The real Billit client is finance-P4's (cross-module D47). Wave 0 ships this stub with the
 * final `createBillitClient` signature so `apps/web/lib/integrations.ts` compiles; every
 * method throws `NotImplementedError` (permanent), so a job against it goes dead with a clear
 * reason instead of retrying.
 */
import { NotImplementedError } from "@beam/core/errors";
import type { BillitApi, BillitClientOptions } from "./types";

export function createBillitClient(opts: BillitClientOptions): BillitApi {
  void opts;
  const notYet = (method: string) => (): Promise<never> => Promise.reject(new NotImplementedError(`billit.${method} (finance-P4)`));
  return {
    upsertParty: notYet("upsertParty"),
    createOrder: notYet("createOrder"),
    findOrderByReference: notYet("findOrderByReference"),
    getOrder: notYet("getOrder"),
    listOrdersSince: notYet("listOrdersSince"),
    sendOrder: notYet("sendOrder"),
    registerPayment: notYet("registerPayment"),
    anonymiseCustomer: notYet("anonymiseCustomer"),
  };
}
