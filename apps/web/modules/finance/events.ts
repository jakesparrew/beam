/**
 * finance timeline events (finance spec 4.7, 02-data-model section 4). Facade read by
 * `pnpm gen:indexes`. Every V1 finance kind is declared here once (finance-P2); later finance
 * packages record the emailed, reminder, overdue and company-request kinds. Events carry no
 * address, email or VAT number. `subject: 'either'`: a document of a company without a person
 * attaches to the company; a document with neither (anonymous POS sale, erased person) records
 * no event at all.
 */
import { z } from "zod";
import { defineEvent } from "@/lib/events";

const uuid = z.uuid();
const number = z.string().regex(/^(BEAM|CN)-\d{4}-\d{6}$/);

export const events = [
  defineEvent({
    kind: "invoice.issued",
    subject: "either",
    data: z.object({
      invoice_id: uuid,
      number,
      total_cents: z.number().int(),
      is_company: z.boolean(),
      status: z.enum(["paid", "open"]),
    }),
  }),
  defineEvent({
    kind: "invoice.paid",
    subject: "either",
    data: z.object({ invoice_id: uuid, number, settled_via: z.enum(["provider", "billit", "manual", "credit_note"]) }),
  }),
  defineEvent({
    kind: "credit_note.issued",
    subject: "either",
    data: z.object({
      credit_note_id: uuid,
      number,
      invoice_number: number,
      total_cents: z.number().int(),
      refund_id: uuid.nullable(),
    }),
  }),
  defineEvent({
    kind: "credit_note.settled",
    subject: "either",
    data: z.object({ credit_note_id: uuid, number, refund_id: uuid.nullable() }),
  }),
  defineEvent({
    kind: "invoice.emailed",
    subject: "either",
    data: z.object({ invoice_id: uuid, number, reason: z.string().min(1).max(64) }),
  }),
  defineEvent({
    kind: "invoice.reminder_sent",
    subject: "either",
    data: z.object({ invoice_id: uuid, number }),
  }),
  defineEvent({
    kind: "invoice.overdue",
    subject: "either",
    data: z.object({ invoice_id: uuid, number, days_overdue: z.number().int().nonnegative(), total_cents: z.number().int() }),
  }),
  defineEvent({
    kind: "invoice.company_requested",
    subject: "either",
    data: z.object({ request_id: uuid, invoice_number: number }),
  }),
  defineEvent({
    kind: "invoice.company_request_decided",
    subject: "either",
    data: z.object({ request_id: uuid, invoice_number: number, decision: z.enum(["approved", "rejected"]) }),
  }),
  defineEvent({
    kind: "invoice.company_request_cancelled",
    subject: "either",
    data: z.object({ request_id: uuid, invoice_number: number }),
  }),
] as const;
