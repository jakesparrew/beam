"use server";
/**
 * ops server actions, area `privacy`: privacy requests, erasure orchestration and the subject export (ops spec 4.1). Created empty by ops-P1;
 * ops-P5 adds here: createPrivacyRequest, verifyPrivacyRequest, runPrivacyRequestNow, cancelPrivacyRequest, completeRectification, liftRestriction, requestMyPrivacyAction, cancelMyErasure. Every action goes through `action()` from `@/lib/action`
 * with its Zod input from `@beam/core/ops`; a "use server" file exports async functions only.
 */
export {};
