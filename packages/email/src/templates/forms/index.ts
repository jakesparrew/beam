/**
 * forms' transactional templates (forms spec section 8, cross-module D2 and D4). Registry keys
 * and `email_templates.slug` values: `forms.result`, `forms.result_link`. Copy lives in forms'
 * catalogue under `forms.email.<name>.<slot>`. Neither declares `loadProps`: no automation step
 * sends them (forms sends their `data` itself).
 */
import { FORM_RESULT_LINK_SAMPLE, FORM_RESULT_SAMPLE } from "@beam/core/forms";
import { defineTemplate } from "../define";
import { formResultSlots, FormResultProps, Result } from "./result";
import { formResultLinkSlots, FormResultLinkProps, ResultLink } from "./result-link";

export const templates = [
  defineTemplate({
    name: "result",
    component: Result,
    props: FormResultProps,
    slots: formResultSlots,
    sample: FORM_RESULT_SAMPLE,
  }),
  defineTemplate({
    name: "result_link",
    component: ResultLink,
    props: FormResultLinkProps,
    slots: formResultLinkSlots,
    sample: FORM_RESULT_LINK_SAMPLE,
  }),
];
