"use server";
/**
 * ops server actions, area `ai`: natural-language questions and the weekly management summary (R4) (ops spec 4.1). Created empty by ops-P1;
 * ops-P10 adds here: askQuestion, regenerateWeeklySummary. Every action goes through `action()` from `@/lib/action`
 * with its Zod input from `@beam/core/ops`; a "use server" file exports async functions only.
 */
export {};
