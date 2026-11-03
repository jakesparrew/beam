/**
 * `@beam/core/credits`: the module's pure rules and schemas (credits-P2): allocation, thresholds,
 * expiry, membership periods and dunning, commercial status, wording keys, VAT treatment, the
 * status machines and the Zod inputs. No I/O.
 */
export * from "./types";
export * from "./allocate";
export * from "./thresholds";
export * from "./expiry";
export * from "./periods";
export * from "./status";
export * from "./wording";
export * from "./vat";
export * from "./state-machines";
export * from "./schemas";

// The Wave 0 skeleton in `types.ts` guessed these two shapes; the spec's section 4 shapes win.
export type { AllocationResult } from "./allocate";
export type { GrantSharing } from "./schemas";
