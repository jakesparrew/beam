"use server";
/**
 * webinar server actions (webinar spec 4.2). Each is `action()` from lib/action.ts with audience
 * `staff` and permission `webinars.host`; the work is in `server/lifecycle.ts`, which writes the
 * spec's own audit names (`webinar.created`, `webinar.updated`, ...), so every action here passes
 * `audit: false`. A "use server" file exports async functions only.
 *
 * webinar-P2: create, update, publish, cancel, archive, duplicate, set video, polls, CTAs,
 * presenters and force live state. Later packages add registration, host console and export
 * actions.
 */
import {
  ArchiveWebinarInput,
  CancelWebinarInput,
  CreateWebinarInput,
  DeleteCtaInput,
  DeletePollInput,
  DuplicateWebinarInput,
  ForceLiveStateInput,
  PublishWebinarInput,
  RemovePresenterInput,
  SetWebinarVideoInput,
  UpdateWebinarInput,
  UpsertCtaInput,
  UpsertPollInput,
  UpsertPresenterInput,
} from "@beam/core/webinar";
import { action } from "@/lib/action";
import * as lifecycle from "./server/lifecycle";

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
