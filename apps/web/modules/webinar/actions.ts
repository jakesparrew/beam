"use server";
/**
 * webinar server actions (webinar spec 4.2). Each is `action()` from lib/action.ts with audience
 * `staff` and permission `webinars.host`; the work is in `server/lifecycle.ts`, which writes the
 * spec's own audit names (`webinar.created`, `webinar.updated`, ...), so every action here passes
 * `audit: false`. A "use server" file exports async functions only.
 *
 * webinar-P2: create, update, publish, cancel, archive, duplicate, set video, polls, CTAs,
 * presenters and force live state. webinar-P3: registration by the customer and by staff,
 * cancellation, the resend and revoke of access links (`server/registration.ts`, rules 14-20)
 * and the public lost-link request. webinar-P5: the host console's live controls (`launchPoll`,
 * `closePoll`, `showCta`, `hideCta`) and `moderate` (hide, unhide, mark answered, mute, unmute,
 * block, unblock; `server/interactions.ts`, rules 21, 34, 37). webinar-P6: the registrant CSV
 * export (`exportWebinarRegistrants`, rule 41: `webinars.host` plus `persons.export`, audited as
 * `webinar.registrants_exported` with the row count).
 */
import {
  ArchiveWebinarInput,
  CancelMyRegistrationInput,
  CancelRegistrationByStaffInput,
  CancelWebinarInput,
  CreateWebinarInput,
  DeleteCtaInput,
  DeletePollInput,
  DuplicateWebinarInput,
  ExportWebinarRegistrantsInput,
  ClosePollInput,
  ForceLiveStateInput,
  HideCtaInput,
  LaunchPollInput,
  ModerateInput,
  ShowCtaInput,
  JoinLinkInput,
  PublishWebinarInput,
  RegisterForWebinarInput,
  RegisterPersonByStaffInput,
  RemovePresenterInput,
  ResendAccessLinkInput,
  RevokeAccessLinkInput,
  SetWebinarVideoInput,
  UpdateWebinarInput,
  UpsertCtaInput,
  UpsertPollInput,
  UpsertPresenterInput,
} from "@beam/core/webinar";
import { z } from "zod";
import { URL_SEGMENT } from "@beam/core/i18n";
import { webinars } from "@beam/db/schema";
import { action } from "@/lib/action";
import { NotFoundError, ValidationError, eq } from "@/lib/ctx";
import { storeFile } from "@/lib/files";
import * as interactions from "./server/interactions";
import * as lifecycle from "./server/lifecycle";
import * as registration from "./server/registration";
import { buildRegistrantsCsv, listRegistrantExportRows } from "./server/report";

const staff = { audience: "staff", permission: "webinars.host", audit: false } as const;

export const createWebinar = action({ name: "webinar.create", ...staff, input: CreateWebinarInput }, (ctx, input) => lifecycle.createWebinar(ctx, input));

export const updateWebinar = action({ name: "webinar.update", ...staff, input: UpdateWebinarInput }, (ctx, input) => lifecycle.updateWebinar(ctx, input));

export const publishWebinar = action({ name: "webinar.publish", ...staff, input: PublishWebinarInput }, (ctx, input) => lifecycle.publishWebinar(ctx, input));

export const cancelWebinar = action({ name: "webinar.cancel", ...staff, input: CancelWebinarInput }, (ctx, input) => lifecycle.cancelWebinar(ctx, input));

export const archiveWebinar = action({ name: "webinar.archive", ...staff, input: ArchiveWebinarInput }, (ctx, input) => lifecycle.archiveWebinar(ctx, input));

export const duplicateWebinar = action({ name: "webinar.duplicate", ...staff, input: DuplicateWebinarInput }, (ctx, input) => lifecycle.duplicateWebinar(ctx, input));

export const setWebinarVideo = action({ name: "webinar.set_webinar_video", ...staff, input: SetWebinarVideoInput }, (ctx, input) => lifecycle.setWebinarVideo(ctx, input));

export const upsertPoll = action({ name: "webinar.upsert_poll", ...staff, input: UpsertPollInput }, (ctx, input) => lifecycle.upsertPoll(ctx, input));

export const deletePoll = action({ name: "webinar.delete_poll", ...staff, input: DeletePollInput }, (ctx, input) => lifecycle.deletePoll(ctx, input));

export const upsertCta = action({ name: "webinar.upsert_cta", ...staff, input: UpsertCtaInput }, (ctx, input) => lifecycle.upsertCta(ctx, input));

export const deleteCta = action({ name: "webinar.delete_cta", ...staff, input: DeleteCtaInput }, (ctx, input) => lifecycle.deleteCta(ctx, input));

export const upsertPresenter = action({ name: "webinar.upsert_presenter", ...staff, input: UpsertPresenterInput }, (ctx, input) =>
  lifecycle.upsertPresenter(ctx, input),
);

export const removePresenter = action({ name: "webinar.remove_presenter", ...staff, input: RemovePresenterInput }, (ctx, input) =>
  lifecycle.removePresenter(ctx, input),
);

export const forceLiveState = action({ name: "webinar.force_live_state", ...staff, input: ForceLiveStateInput }, (ctx, input) => lifecycle.forceLiveState(ctx, input));

// ---------------------------------------------------------------------------------------------
// Host console (webinar-P5, rules 21, 34, 37)
// ---------------------------------------------------------------------------------------------

export const launchPoll = action({ name: "webinar.launch_poll", ...staff, input: LaunchPollInput }, (ctx, input) => interactions.launchPoll(ctx, input));

export const closePoll = action({ name: "webinar.close_poll", ...staff, input: ClosePollInput }, (ctx, input) => interactions.closePoll(ctx, input));

export const showCta = action({ name: "webinar.show_cta", ...staff, input: ShowCtaInput }, (ctx, input) => interactions.showCta(ctx, input));

export const hideCta = action({ name: "webinar.hide_cta", ...staff, input: HideCtaInput }, (ctx, input) => interactions.hideCta(ctx, input));

/** Hide, unhide or mark a message, mute or block a viewer (audited as `webinar.moderated`). */
export const moderate = action({ name: "webinar.moderate", ...staff, input: ModerateInput }, (ctx, input) => interactions.moderate(ctx, input));

// ---------------------------------------------------------------------------------------------
// Registration (webinar-P3, rules 14-20)
// ---------------------------------------------------------------------------------------------

export const registerPersonByStaff = action({ name: "webinar.register_person_by_staff", ...staff, input: RegisterPersonByStaffInput }, (ctx, input) =>
  registration.registerPersonByStaff(ctx, input),
);

export const cancelRegistrationByStaff = action({ name: "webinar.cancel_registration_by_staff", ...staff, input: CancelRegistrationByStaffInput }, (ctx, input) =>
  registration.cancelRegistration(ctx.tx, ctx, input.registrationId, "staff").then(() => ({})),
);

export const revokeAccessLink = action({ name: "webinar.revoke_access_link", ...staff, input: RevokeAccessLinkInput }, async (ctx, input) => {
  ctx.require("persons.read");
  await registration.revokeAccessLink(ctx, input.registrationId);
  return {};
});

/** `persons.read` only: customer service, sales and reception answer "I lost my link" (section 7). */
export const resendAccessLink = action(
  { name: "webinar.resend_access_link", audience: "staff", permission: "persons.read", input: ResendAccessLinkInput, audit: false },
  async (ctx, input) => {
    await registration.resendAccessLink(ctx, input.registrationId);
    return {};
  },
);

/** The portal's one-click registration (source `portal`); the customer's own person only. */
export const registerForWebinar = action({ name: "webinar.register_for_webinar", audience: "customer", input: RegisterForWebinarInput }, async (ctx, input) => {
  if (ctx.actor.kind !== "customer") throw new ValidationError("customer_required");
  const r = await registration.registerPerson(ctx.tx, ctx, {
    webinarId: input.webinarId,
    personId: ctx.actor.personId,
    source: "portal",
    locale: input.locale,
    utm: {},
    consents: input.consents,
    wordingVersion: input.wordingVersion,
  });
  return { registrationId: r.registrationId, watchPath: `/${URL_SEGMENT[input.locale]}/account/webinars/${input.webinarId}` };
});

export const cancelMyRegistration = action({ name: "webinar.cancel_my_registration", audience: "customer", input: CancelMyRegistrationInput }, async (ctx, input) => {
  if (ctx.actor.kind !== "customer") throw new ValidationError("customer_required");
  await registration.cancelMyRegistration(ctx, ctx.actor.personId, input.registrationId);
  return {};
});

/**
 * The lost-link form (`/[locale]/webinars/[slug]/join`): resends the access email when a
 * registration of the address exists; the answer is the same either way (no enumeration). The
 * honeypot `website` must stay empty; 20 requests per IP per minute, shared with registration
 * (`{ limited: true }` past the limit).
 */
export const requestAccessLink = action(
  { name: "webinar.request_access_link", audience: "public", input: JoinLinkInput.extend({ slug: z.string().min(1).max(80) }), audit: false },
  async (ctx, input) => {
    // Answered, not thrown: a thrown error would roll the counted request back.
    if (!(await registration.limitPublicRegistration(ctx.tx, ctx.ip, ctx.now))) return { limited: true };
    await registration.requestAccessLink(ctx.tx, ctx, { slug: input.slug, email: input.email });
    return { limited: false };
  },
);

// ---------------------------------------------------------------------------------------------
// Reporting (webinar-P6, rule 41)
// ---------------------------------------------------------------------------------------------

/** Days a registrant export file stays downloadable. */
const EXPORT_DAYS = 7;

/**
 * The registrant CSV (name, email, status snapshot, per-mode facts) as a `files` row of kind
 * `export` that expires after 7 days; needs `persons.export` on top of `webinars.host`. Audited as
 * `webinar.registrants_exported` with the row count (never the rows).
 */
export const exportWebinarRegistrants = action({ name: "webinar.export_webinar_registrants", ...staff, input: ExportWebinarRegistrantsInput }, async (ctx, input) => {
  ctx.require("persons.export");
  const [w] = await ctx.tx.select({ id: webinars.id, slug: webinars.slug }).from(webinars).where(eq(webinars.id, input.webinarId));
  if (!w) throw new NotFoundError("webinar_not_found");
  const rows = await listRegistrantExportRows(ctx.tx, w.id);
  const bytes = new TextEncoder().encode(`\uFEFF${buildRegistrantsCsv(rows)}`);
  const { fileId } = await storeFile(ctx, {
    kind: "export",
    name: `webinar-${w.slug}-registrants.csv`,
    mime: "text/csv",
    bytes,
    expiresAt: new Date(ctx.now.getTime() + EXPORT_DAYS * 86_400_000),
  });
  await ctx.audit({ action: "webinar.registrants_exported", entityType: "webinar", entityId: w.id, newValue: { rows: rows.length, fileId } });
  return { fileId };
});
