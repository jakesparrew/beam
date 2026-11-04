/**
 * Zod inputs of ops' server actions (ops spec 4.1) and the jsonb shapes ops stores
 * (`ImportMapping`, `DashboardDefinition`). Actions import these; a "use server" file never
 * exports a schema, so they live here.
 */
import { z } from "zod";
import { LOCALES } from "../i18n/locales";
import { CUTOVER_STEPS } from "./cutover";
import { DPIA_KEYS, DPIA_STATUSES } from "./dpia";
import { EXPORT_ENTITIES } from "./export-entities";
import { IMPORT_KINDS, IMPORT_SOURCES } from "./import-targets";
import { PERIODS } from "./periods";
import { RECTIFY_FIELDS, RESTRICTION_REASONS } from "./privacy-notice";
import { RETENTION_DISMISS_REASONS } from "./retention-score";

const uuid = z.uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const note500 = z.string().trim().max(500);

export const CONSENT_PURPOSES = ["newsletter", "events", "member_comms", "b2b", "assessment_result", "sensitive_processing", "ai_processing"] as const;

export const PRIVACY_KINDS = ["export", "erase", "restrict", "rectify", "object"] as const;
export const PRIVACY_STATUSES = ["received", "verified", "running", "done", "failed", "cancelled"] as const;
export const PRIVACY_REQUESTED_BY = ["customer", "staff", "system"] as const;

/** Action dashboard cards (rules 23-32), V1 to R3. */
export const ACTION_CARD_KEYS = [
  "packages_nearing_completion",
  "vip_inactive",
  "new_leads_follow_up",
  "b2b_proposals",
  "memberships_expiring",
  "failed_payments",
  "webinar_leads_not_booked",
  "unused_packages_expiring",
  "shared_package_abuse",
  "overdue_tasks",
  "overdue_privacy_requests",
] as const;
export type ActionCardKey = (typeof ACTION_CARD_KEYS)[number];

/** `imports.mapping` (ops spec 2.2). */
export const ImportMapping = z.object({
  columns: z.record(z.string().max(200), z.string().max(64).nullable()),
  options: z.object({
    delimiter: z.enum([",", ";", "\t"]),
    dateFormat: z.enum(["iso", "dd/mm/yyyy", "mm/dd/yyyy"]),
    defaultLocale: z.enum(LOCALES),
    overwrite: z.boolean(),
    consentPurpose: z.enum(CONSENT_PURPOSES).optional(),
    consentWordingVersion: z.string().max(64).optional(),
    productId: uuid.optional(),
    creditKind: z.enum(["day", "night", "euro"]).optional(),
    tagKey: z.string().max(64).optional(),
    preset: z.string().max(64).optional(),
  }),
});
export type ImportMapping = z.infer<typeof ImportMapping>;

/** `dashboards.definition` (R4): at most 24 widgets. */
export const DashboardDefinition = z.object({
  widgets: z
    .array(
      z.object({
        id: z.string().min(1).max(40),
        kpi: z.string().min(1).max(64),
        period: z.enum(PERIODS),
        compare: z.boolean(),
        segmentId: uuid.optional(),
        filters: z.record(z.string(), z.string()).optional(),
        viz: z.enum(["number", "line", "bar", "table"]),
      }),
    )
    .max(24),
});
export type DashboardDefinition = z.infer<typeof DashboardDefinition>;

// --- Stats and dashboard -------------------------------------------------------------------

export const RecalculatePersonStatsInput = z.object({ personId: uuid });
export const CreateTaskFromCardInput = z.object({
  card: z.enum(ACTION_CARD_KEYS),
  personId: uuid,
  refType: z.string().max(40).optional(),
  refId: uuid.optional(),
  ownerUserId: uuid.optional(),
});
export const DashboardViewInput = z.object({ view: z.enum(["today", "week"]).default("today") });
export const RevenueReportInput = z.object({ period: z.enum(PERIODS), at: z.coerce.date(), vat: z.enum(["incl", "excl"]).default("incl") });

// --- Retention (R2) -------------------------------------------------------------------------

export const CreateRetentionTaskInput = z.object({ itemId: uuid, ownerUserId: uuid.optional() });
export const CreateAllRetentionTasksInput = z.object({ listId: uuid, ownerUserId: uuid.optional() });
export const DismissRetentionItemInput = z.object({ itemId: uuid, reason: z.enum(RETENTION_DISMISS_REASONS), note: note500.optional() });
export const RebuildRetentionListInput = z.object({});

// --- Imports --------------------------------------------------------------------------------

export const CreateImportInput = z.object({
  kind: z.enum(IMPORT_KINDS),
  source: z.enum(IMPORT_SOURCES),
  name: z.string().trim().min(1).max(120),
  fileIds: z.array(uuid).min(1).max(17),
});
export const SaveImportMappingInput = z.object({ importId: uuid, mapping: ImportMapping });
export const StartDryRunInput = z.object({ importId: uuid });
export const StartImportInput = z.object({ importId: uuid, confirmNoSuppressionSource: z.boolean().optional(), confirmDifferentFile: z.boolean().optional() });
export const CancelImportInput = z.object({ importId: uuid });
export const SignOffReconciliationInput = z.object({ importId: uuid, note: z.string().trim().min(1).max(500) });
export const SetCutoverStepInput = z.object({ key: z.enum(CUTOVER_STEPS), done: z.boolean(), note: note500.optional() });

// --- Exports, retention policies, DPIA ------------------------------------------------------

export const CreateExportInput = z
  .object({
    kind: z.enum(["entity", "full"]),
    entity: z.enum(EXPORT_ENTITIES).optional(),
    filters: z.object({ from: isoDate.optional(), to: isoDate.optional(), segmentId: uuid.optional() }).optional(),
  })
  .refine((v) => (v.kind === "entity") === (v.entity !== undefined), { message: "entity is required for an entity export and not allowed for a full export", path: ["entity"] });
export const UpdateRetentionPolicyInput = z.object({
  key: z.string().regex(/^[a-z]+\.[a-z][a-z0-9_]*$/),
  days: z.number().int().min(1).max(3653).optional(),
  isActive: z.boolean().optional(),
});
export const UpdateDpiaRecordInput = z
  .object({
    key: z.enum(DPIA_KEYS),
    status: z.enum(DPIA_STATUSES),
    purpose: z.string().max(4000).optional(),
    risks: z.string().max(4000).optional(),
    measures: z.string().max(4000).optional(),
    decisionNote: z.string().trim().max(2000).optional(),
    documentFileId: uuid.optional(),
  })
  .refine((v) => !(v.status === "approved" || v.status === "not_required") || !!v.decisionNote, {
    message: "a decision note is required to approve or mark not required",
    path: ["decisionNote"],
  });

// --- Privacy --------------------------------------------------------------------------------

export const CreatePrivacyRequestInput = z.object({
  personId: uuid,
  kind: z.enum(PRIVACY_KINDS),
  verificationNote: note500.optional(),
  rectifyFields: z.array(z.enum(RECTIFY_FIELDS)).max(RECTIFY_FIELDS.length).optional(),
});
export const VerifyPrivacyRequestInput = z.object({ requestId: uuid, verificationNote: z.string().trim().min(1).max(500), acknowledgeWarnings: z.boolean() });
export const RunPrivacyRequestNowInput = z.object({ requestId: uuid });
export const CancelPrivacyRequestInput = z.object({ requestId: uuid, reason: note500 });
export const CompleteRectificationInput = z.object({ requestId: uuid });
export const LiftRestrictionInput = z.object({ personId: uuid, reason: note500 });
export const RestrictionReasonSchema = z.enum(RESTRICTION_REASONS);
export const RequestMyPrivacyActionInput = z.object({
  kind: z.enum(PRIVACY_KINDS),
  rectifyFields: z.array(z.enum(RECTIFY_FIELDS)).max(RECTIFY_FIELDS.length).optional(),
  /** Erasure only: the typed word of the customer's locale (`DELETE`, `VERWIJDER`, `SUPPRIMER`). */
  confirmWord: z.string().max(20).optional(),
});
export const CancelMyErasureInput = z.object({ requestId: uuid });

// --- Marketing and AI (R3, R4) --------------------------------------------------------------

export const PullAdsNowInput = z.object({ days: z.number().int().min(1).max(90) });
export const SaveDashboardInput = z.object({ id: uuid.optional(), name: z.string().trim().min(1).max(120), definition: DashboardDefinition, isShared: z.boolean() });
export const DeleteDashboardInput = z.object({ id: uuid });
export const AskQuestionInput = z.object({ question: z.string().trim().min(3).max(500) });
export const RegenerateWeeklySummaryInput = z.object({ weekStartOn: isoDate });

/** `ads` setting (R3): the accounts `ads.pull_yesterday` reads. */
export const AdsSettings = z.object({ meta_account_ids: z.array(z.string().max(64)), google_customer_ids: z.array(z.string().max(64)) });
export type AdsSettings = z.infer<typeof AdsSettings>;
export const ADS_SETTINGS_DEFAULT: AdsSettings = { meta_account_ids: [], google_customer_ids: [] };
