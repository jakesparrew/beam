/**
 * crm timeline events (crm spec 4.7). Facade read by `pnpm gen:indexes`: every crm kind, V1 and
 * R3 (the R3 kinds stay unused until crm-P8 and crm-P9). `data` keys are the stable contract and
 * never hold email addresses, phone numbers or sensitive values; a sensitive note is stored as
 * `{ body_enc, key_version }` with `isSensitive` on the write (rule 3.26). `source` on caused
 * events lets automation rule A-7 ignore what an automation or an import did.
 */
import { z } from "zod";
import { ACQUISITION_SOURCES, CONSENT_METHODS, CONSENT_PURPOSES, PERSON_STATUSES, SUPPRESSION_REASONS, SUPPRESSION_SCOPES } from "@beam/core/crm";
import { LOCALES } from "@beam/core/i18n";
import { defineEvent } from "@/lib/events";

const uuid = z.uuid();
const status = z.enum(PERSON_STATUSES);
const causedBy = z.enum(["manual", "automation", "import", "form", "system"]);
const tagData = z.object({ tag_key: z.string(), source: causedBy });
const taskRef = z.object({ task_id: uuid });
const segmentRef = z.object({ segment_id: uuid });
const consentData = z.object({ purpose: z.enum(CONSENT_PURPOSES), method: z.enum(CONSENT_METHODS), lawful_basis: z.enum(["consent", "legitimate_interest"]).optional() });
const stage = z.string().min(1).max(64);
const opportunityData = z.object({ opportunity_id: uuid, from_stage: stage.optional(), to_stage: stage.optional(), value_cents: z.number().int().nonnegative().optional() });
const inboxData = z.object({ thread_id: uuid, channel: z.enum(["email", "instagram", "messenger", "form"]) });

export const events = [
  // persons
  defineEvent({
    kind: "person.created",
    subject: "person",
    data: z.object({
      acquisition_source: z.enum(ACQUISITION_SOURCES).optional(),
      acquisition_campaign: z.string().optional(),
      acquisition_medium: z.string().optional(),
      source: causedBy,
    }),
  }),
  defineEvent({ kind: "person.updated", subject: "person", data: z.object({ fields: z.array(z.string()) }) }),
  defineEvent({ kind: "person.locale_changed", subject: "person", data: z.object({ from: z.enum(LOCALES).nullable().optional(), to: z.enum(LOCALES) }) }),
  defineEvent({ kind: "person.acquisition_filled", subject: "person", data: z.object({ acquisition_source: z.enum(ACQUISITION_SOURCES) }) }),
  defineEvent({
    kind: "person.status_overridden",
    subject: "person",
    data: z.object({ from: status.nullable(), to: status, reason: z.string().max(500).optional(), source: z.enum(["manual", "automation"]) }),
  }),
  defineEvent({ kind: "person.status_override_cleared", subject: "person", data: z.object({ from: status, reason: z.string().max(500).optional() }) }),
  defineEvent({ kind: "person.status_override_confirmed", subject: "person", data: z.object({ status, derived_status: status }) }),
  defineEvent({ kind: "person.merged", subject: "person", data: z.object({ merge_id: uuid, role: z.enum(["winner", "loser"]), other_person_id: uuid }) }),
  // notes and interactions (a sensitive note bypasses this schema: its data is the encrypted body)
  defineEvent({ kind: "note.added", subject: "either", data: z.object({ body: z.string().min(1).max(10_000) }) }),
  defineEvent({
    kind: "interaction.logged",
    subject: "either",
    data: z.object({
      channel: z.enum(["call", "email", "whatsapp", "in_person", "meeting", "other"]),
      purpose: z.enum(["service", "sales_follow_up", "reactivation", "b2b"]),
      summary: z.string().min(1).max(2000),
    }),
  }),
  // consent and suppression
  defineEvent({ kind: "consent.granted", subject: "person", data: consentData }),
  defineEvent({ kind: "consent.withdrawn", subject: "person", data: consentData }),
  defineEvent({ kind: "suppression.added", subject: "person", data: z.object({ scope: z.enum(SUPPRESSION_SCOPES), reason: z.enum(SUPPRESSION_REASONS) }) }),
  // tags and segments
  defineEvent({ kind: "tag.added", subject: "person", data: tagData }),
  defineEvent({ kind: "tag.removed", subject: "person", data: tagData }),
  defineEvent({ kind: "segment.entered", subject: "person", data: segmentRef }),
  defineEvent({ kind: "segment.left", subject: "person", data: segmentRef }),
  // tasks
  defineEvent({
    kind: "task.created",
    subject: "either",
    data: z.object({ task_id: uuid, kind: z.enum(["call", "follow_up", "payment", "proposal", "review", "other"]), source: z.enum(["manual", "automation", "retention", "system"]) }),
  }),
  defineEvent({ kind: "task.completed", subject: "either", data: taskRef }),
  defineEvent({ kind: "task.cancelled", subject: "either", data: taskRef }),
  defineEvent({ kind: "task.reopened", subject: "either", data: taskRef }),
  // sensitive fields and declarations
  defineEvent({ kind: "sensitive.updated", subject: "person", data: z.object({ key: z.enum(["health_note", "sleep", "stress", "recovery", "wellbeing", "medical"]) }) }),
  defineEvent({
    kind: "declaration.accepted",
    subject: "person",
    data: z.object({ kind: z.literal("guardian_consent"), document_version: z.number().int().positive(), method: z.enum(["portal", "reception", "form", "import"]) }),
  }),
  defineEvent({ kind: "declaration.revoked", subject: "person", data: z.object({ kind: z.literal("guardian_consent") }) }),
  // companies
  defineEvent({ kind: "company.created", subject: "company", data: z.object({ name: z.string().max(200) }) }),
  defineEvent({ kind: "company.updated", subject: "company", data: z.object({ fields: z.array(z.string()) }) }),
  defineEvent({
    kind: "company.contact_linked",
    subject: "either",
    data: z.object({ contact_id: uuid, decision_role: z.enum(["decision_maker", "influencer", "user", "gatekeeper"]).nullable().optional() }),
  }),
  defineEvent({ kind: "company.contact_unlinked", subject: "either", data: z.object({ contact_id: uuid }) }),
  // R3: pipeline
  defineEvent({ kind: "opportunity.created", subject: "company", data: opportunityData }),
  defineEvent({ kind: "opportunity.updated", subject: "company", data: opportunityData.extend({ fields: z.array(z.string()).optional() }) }),
  defineEvent({ kind: "opportunity.stage_changed", subject: "company", data: opportunityData }),
  defineEvent({ kind: "opportunity.won", subject: "company", data: opportunityData }),
  defineEvent({ kind: "opportunity.lost", subject: "company", data: opportunityData.extend({ reason: z.string().max(500).optional() }) }),
  defineEvent({ kind: "opportunity.reopened", subject: "company", data: opportunityData }),
  // R3: inbox
  defineEvent({ kind: "inbox.message_received", subject: "either", data: inboxData }),
  defineEvent({ kind: "inbox.reply_sent", subject: "either", data: inboxData }),
  defineEvent({ kind: "inbox.escalated", subject: "person", data: inboxData }),
];
