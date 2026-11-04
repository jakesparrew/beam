/**
 * crm Server Actions (crm spec 4.1). A barrel written once by crm-P1 for every V1 area; each
 * area's `actions.ts` is a "use server" file built on `action()` and implemented by its package
 * (P2 persons and tags, P3 consent, portal and declarations, P4 duplicates, merge and sensitive,
 * P5 segments, P6 tasks and companies, P7 timeline). R3 areas are added by crm-P8.
 */
export { confirmStatusOverride, createPerson, fillAcquisition, setStatusOverride, updatePerson } from "./persons/actions";
export { createTag, deleteTag, tagPersons, untagPersons, updateTag } from "./tags/actions";
export { addManualSuppression, publishConsentWording, recordStaffConsent, updatePreferencesByToken } from "./consent/actions";
export { updateMyPreferences, updateMyProfile } from "./portal/actions";
export { recordDeclaration, revokeDeclaration } from "./declarations/actions";
export { dismissDuplicate } from "./duplicates/actions";
export { mergePersons } from "./merge/actions";
export { revealSensitive, setSensitiveField } from "./sensitive/actions";
export { archiveSegment, refreshSegmentNow, saveSegment, setStaticMembers } from "./segments/actions";
export { cancelTask, completeTask, createTask, reopenTask, updateTask } from "./tasks/actions";
export { endContact, linkContact, saveCompany, updateContact } from "./companies/actions";
export { addNote, logInteraction } from "./timeline/actions";
