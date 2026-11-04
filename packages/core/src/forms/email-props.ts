/**
 * Props schemas of the two transactional templates forms writes in
 * `packages/email/src/templates/forms/` (forms spec section 8, cross-module D2 and D4).
 * Dynamic texts are already resolved to the submission locale by forms. The result email never
 * carries a sensitive dimension value or a raw answer (SE4): `scoreLine` is the non-sensitive
 * total only.
 */
import { z } from "zod";

const line = z.string().max(5000);
const https = z.url({ protocol: /^https?$/ }).max(2000);

export type FormResultProps = {
  firstName: string | null;
  formTitle: string;
  outcomeLabel: string | null;
  /** Non-sensitive total only (for example "Your score: 18 of 30"), or null. */
  scoreLine: string | null;
  explanation: string | null;
  recommendation: string | null;
  intro: string | null;
  resultUrl: string;
  ctas: { label: string; url: string }[];
  /** Adds "Check your inbox to confirm your subscription" (rule C1). */
  pendingConfirmation: boolean;
};

export type FormResultLinkProps = {
  firstName: string | null;
  formTitle: string;
  resultUrl: string;
};

/** `forms.result`. */
export const FormResultProps: z.ZodType<FormResultProps> = z
  .object({
    firstName: z.string().max(200).nullable(),
    formTitle: z.string().min(1).max(500),
    outcomeLabel: z.string().max(500).nullable(),
    scoreLine: z.string().max(200).nullable(),
    explanation: line.nullable(),
    recommendation: line.nullable(),
    intro: line.nullable(),
    resultUrl: https,
    ctas: z.array(z.object({ label: z.string().min(1).max(200), url: https }).strict()).max(4),
    pendingConfirmation: z.boolean(),
  })
  .strict();

/** `forms.result_link`. */
export const FormResultLinkProps: z.ZodType<FormResultLinkProps> = z
  .object({
    firstName: z.string().max(200).nullable(),
    formTitle: z.string().min(1).max(500),
    resultUrl: https,
  })
  .strict();

/** Sample data for email's `define.test.ts` (no personal data). */
export const FORM_RESULT_SAMPLE: FormResultProps = {
  firstName: "Lotte",
  formTitle: "Recovery check",
  outcomeLabel: "Ready for a reset",
  scoreLine: "Your habits score: 18 of 30",
  explanation: "Your daily habits leave room for more recovery.",
  recommendation: "Start with a BEAM day session to reset.",
  intro: "Thank you for taking the recovery check. Here is your result.",
  resultUrl: "https://beam.example.com/en/f/recovery-check/r/sample-token",
  ctas: [{ label: "Book a day session", url: "https://beam.example.com/en/account/book" }],
  pendingConfirmation: false,
};

export const FORM_RESULT_LINK_SAMPLE: FormResultLinkProps = {
  firstName: "Lotte",
  formTitle: "Recovery check",
  resultUrl: "https://beam.example.com/en/f/recovery-check/r/sample-token",
};
