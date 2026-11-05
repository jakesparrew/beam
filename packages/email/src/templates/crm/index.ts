/**
 * crm's transactional templates (crm spec 4.4, rules 3.21 and 3.50). Registry keys and
 * `email_templates.slug` values: `crm.confirm_resubscribe`, `crm.preference_link` and R3
 * `crm.inbox_reply`. Copy lives in crm's catalogue under `crm.email.<name>.<slot>`.
 */
import { defineTemplate } from "../define";
import { ConfirmResubscribe, ConfirmResubscribeProps, confirmResubscribeSlots } from "./confirm-resubscribe";
import { InboxReply, InboxReplyProps, inboxReplySlots } from "./inbox-reply";
import { PreferenceLink, PreferenceLinkProps, preferenceLinkSlots } from "./preference-link";

export const templates = [
  defineTemplate({
    name: "confirm_resubscribe",
    component: ConfirmResubscribe,
    props: ConfirmResubscribeProps,
    slots: confirmResubscribeSlots,
    sample: { purpose: "newsletter", firstName: "Sofie", preferencesUrl: "https://beam.example.com/api/public/preferences?t=sample-token" },
  }),
  defineTemplate({
    name: "preference_link",
    component: PreferenceLink,
    props: PreferenceLinkProps,
    slots: preferenceLinkSlots,
    sample: { firstName: "Sofie", preferencesUrl: "https://beam.example.com/api/public/preferences?t=sample-token" },
  }),
  defineTemplate({
    name: "inbox_reply",
    component: InboxReply,
    props: InboxReplyProps,
    slots: inboxReplySlots,
    sample: { subject: "Question about my sauna booking", body: "Hello Sofie,\n\nThank you for your message. Your booking is confirmed.\n\nKind regards,\nBEAM" },
  }),
];
