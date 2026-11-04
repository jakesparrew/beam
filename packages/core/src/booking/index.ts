/**
 * `@beam/core/booking`: booking's pure core (booking spec 4.1): types, the settings schemas,
 * schedule maths, availability, policy and state machines, the waitlist, claim tokens,
 * duplicate signals, check-in codes, labels and the error classes. Belgian public holidays come
 * from `@beam/core/platform` (`belgianPublicHolidays`, R4b).
 */
export * from "./types";
export * from "./rules";
export * from "./errors";
export * from "./schedule";
export * from "./availability";
export * from "./policy";
export * from "./waitlist";
export * from "./claim-token";
export * from "./duplicates";
export * from "./checkin-code";
export * from "./describe";
