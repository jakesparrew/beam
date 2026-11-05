/**
 * Meta Messenger and Instagram webhook shapes (crm spec section 6, R3). Only the fields the
 * unified inbox reads are declared; everything else passes through. A webhook body is
 * `{ object: 'page' | 'instagram', entry: [{ id, time, messaging: [...] }] }`; each messaging
 * item with a `message` (and no `is_echo`) is one inbound customer message.
 */
import { z } from "zod";

export const MetaWebhookMessage = z
  .object({
    mid: z.string().min(1),
    text: z.string().optional(),
    is_echo: z.boolean().optional(),
    attachments: z.array(z.unknown()).optional(),
  })
  .loose();

export const MetaWebhookMessaging = z
  .object({
    sender: z.object({ id: z.string().min(1) }).loose(),
    recipient: z.object({ id: z.string().min(1) }).loose(),
    timestamp: z.number().optional(),
    message: MetaWebhookMessage.optional(),
  })
  .loose();

export const MetaWebhookEntry = z
  .object({
    id: z.string().optional(),
    time: z.number().optional(),
    messaging: z.array(MetaWebhookMessaging).optional(),
  })
  .loose();

export const MetaWebhookBody = z
  .object({
    object: z.string(),
    entry: z.array(MetaWebhookEntry).default([]),
  })
  .loose();
export type MetaWebhookBody = z.infer<typeof MetaWebhookBody>;

/** The channel of a webhook `object`: `instagram` for Instagram, `messenger` for a Facebook page. */
export type MetaChannel = "instagram" | "messenger";

/** One inbound customer message, as `parseWebhook` returns it. */
export type MetaInbound = {
  channel: MetaChannel;
  /** Meta's message id (`inbox_messages.external_message_id`). */
  mid: string;
  /** The page-scoped (or Instagram-scoped) sender id; the thread key. */
  senderId: string;
  recipientId: string;
  text: string;
  attachmentCount: number;
  sentAt: Date;
};

/** The Send API answer. */
export const MetaSendResponse = z.object({ recipient_id: z.string().optional(), message_id: z.string().min(1) }).loose();

/** The Graph API error body (`code` 10 with subcode 2018278 = outside the 24-hour window). */
export const MetaErrorBody = z
  .object({ error: z.object({ message: z.string().optional(), code: z.number().optional(), error_subcode: z.number().optional() }).loose() })
  .loose();
