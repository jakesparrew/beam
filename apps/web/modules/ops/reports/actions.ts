"use server";
/**
 * ops server actions, area `reports`: basic reporting and the report CSV registry (ops spec 4.1). Created empty by ops-P1;
 * ops-P3 adds here: (none: reports are queries and the CSV route). Every action goes through `action()` from `@/lib/action`
 * with its Zod input from `@beam/core/ops`; a "use server" file exports async functions only.
 */
export {};
