/**
 * ops' transactional templates (ops rules 60 and 64). Registry keys and `email_templates.slug`
 * values: `ops.privacy_export_ready`, `ops.privacy_erasure_scheduled`. Copy lives in ops'
 * catalogue under `ops.email.<name>.<slot>`.
 */
import { defineTemplate } from "../define";
import { PrivacyErasureScheduled, PrivacyErasureScheduledProps, privacyErasureScheduledSample, privacyErasureScheduledSlots } from "./privacy-erasure-scheduled";
import { PrivacyExportReady, PrivacyExportReadyProps, privacyExportReadySample, privacyExportReadySlots } from "./privacy-export-ready";

export const templates = [
  defineTemplate({
    name: "privacy_export_ready",
    component: PrivacyExportReady,
    props: PrivacyExportReadyProps,
    slots: privacyExportReadySlots,
    sample: privacyExportReadySample,
  }),
  defineTemplate({
    name: "privacy_erasure_scheduled",
    component: PrivacyErasureScheduled,
    props: PrivacyErasureScheduledProps,
    slots: privacyErasureScheduledSlots,
    sample: privacyErasureScheduledSample,
  }),
];
