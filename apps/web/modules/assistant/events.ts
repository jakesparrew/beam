/**
 * assistant timeline events (`defineEvent`). Facade read by `pnpm gen:indexes`: every `kind` is a
 * literal. All have subject `person` and are written only once a visitor is a CRM person, so
 * automations and segments can act on them like on any other fact.
 */
import { z } from "zod";
import { defineEvent } from "@/lib/events";

export const AssistantLeadCapturedData = z.object({
  conversation_id: z.uuid(),
  role: z.enum(["guide", "coach"]),
  page: z.string().nullable(),
  newsletter: z.boolean(),
});

export const AssistantLeadQualifiedData = z.object({
  conversation_id: z.uuid(),
  score: z.number().int().min(0).max(100),
  reason: z.string(),
});

export const AssistantHandoffRequestedData = z.object({
  conversation_id: z.uuid(),
  reason: z.string().max(300),
});

export const AssistantConversationAnalysedData = z.object({
  conversation_id: z.uuid(),
  intent: z.string(),
  interests: z.array(z.string()),
  score: z.number().int().min(0).max(100),
  tags: z.array(z.string()),
});

export const events = [
  defineEvent({ kind: "assistant.lead_captured", subject: "person", data: AssistantLeadCapturedData }),
  defineEvent({ kind: "assistant.lead_qualified", subject: "person", data: AssistantLeadQualifiedData }),
  defineEvent({ kind: "assistant.handoff_requested", subject: "person", data: AssistantHandoffRequestedData }),
  defineEvent({ kind: "assistant.conversation_analysed", subject: "person", data: AssistantConversationAnalysedData }),
] as const;
