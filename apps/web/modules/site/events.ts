/**
 * site timeline events (site spec section 4, 02-data-model 4.6). Facade read by `pnpm gen:indexes`.
 * `site.terms_accepted`: subject person, `ref_type = 'page_version'`, `dedupe_key` = the terms
 * acceptance idempotency key (written by `recordTermsAcceptance`, site-P5).
 */
import { z } from "zod";
import { defineEvent } from "@/lib/events";

export const events = [
  defineEvent({
    kind: "site.terms_accepted",
    subject: "person",
    data: z.object({
      legal_key: z.enum(["privacy_notice", "terms", "cookie_notice", "accessibility_statement", "guardian_consent"]),
      context: z.enum(["checkout", "signup", "booking", "portal_prompt", "pos", "import"]),
      version_ordinal: z.number().int().min(1),
    }),
  }),
];
