/**
 * crm read functions for its own screens (crm spec 4.3). A barrel written once by crm-P1 for
 * every V1 area; each function is implemented by the package that owns the area. R3: crm-P8
 * the pipeline board and playbook.
 */
export { listPersons, searchPersons, type PersonListRow } from "./persons/queries";
export { listTags, type TagRow } from "./tags/queries";
export { getPreferenceState, listConsentWordings, type PreferenceState } from "./consent/queries";
export { getMyPreferences, getMyProfile, type MyPreferences, type MyProfile } from "./portal/queries";
export { listPersonDeclarations, type DeclarationRow } from "./declarations/queries";
export { listDuplicateCandidates, type DuplicateCandidateRow } from "./duplicates/queries";
export { getMergePreview, type MergePreview } from "./merge/queries";
export { listSensitiveKeys } from "./sensitive/queries";
export { getSegment, listSegments, previewSegment, type SegmentRow } from "./segments/queries";
export { getTaskCounts, listTasks, type TaskRow } from "./tasks/queries";
export { getCompany, listCompanies, type CompanyDetail, type CompanyRow } from "./companies/queries";
export { getTimeline } from "./timeline/queries";
export { getPerson360, type Person360 } from "./person360/queries";
export { getOpportunity, getOpportunityFormOptions, getPipelineBoard, listPlaybookStages, type BoardColumn, type OpportunityCard, type OpportunityDetail, type OpportunityFormOptions, type PipelineBoard } from "./pipeline/queries";
