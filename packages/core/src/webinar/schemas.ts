/**
 * Zod inputs of the webinar server surface (webinar spec section 4): the actions of 4.2 named
 * `<Action>Input`, the route bodies of 4.4 and the jsonb shapes of section 2.3 (`PollOptions`,
 * `TagRules`, `UtmSchema`). Completeness over `webinars.locales` is checked at publish time
 * (`assertComplete`), so drafts may hold partial `LocalizedText`.
 */
import { z } from "zod";
import { LOCALES, LocalizedTextSchema } from "../i18n";
import {
  MODERATION_ACTIONS,
  PRESENTER_ROLES,
  WATCH_MODES,
  WEBINAR_MODES,
} from "./types";

const uuid = z.uuid();
const LocaleSchema = z.enum(LOCALES);
const WatchModeSchema = z.enum(WATCH_MODES);
const KEY = /^[a-z0-9_]{1,40}$/;
const OPTION_KEY = /^[a-z0-9_]{1,20}$/;
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

export const SlugSchema = z
  .string()
  .max(80)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/);
export const SeriesKeySchema = z.string().regex(/^[a-z0-9-]{3,60}$/);
export const VideoIdSchema = z.string().regex(VIDEO_ID);
export const ItemKeySchema = z.string().regex(KEY);

/** `webinars.locales`: one to three distinct locales. */
export const WebinarLocalesSchema = z
  .array(LocaleSchema)
  .min(1)
  .max(3)
  .refine((l) => new Set(l).size === l.length, { message: "duplicate locale" });

/** `webinar_registrations.utm`. */
export const UtmSchema = z
  .object({
    source: z.string().max(200).optional(),
    medium: z.string().max(200).optional(),
    campaign: z.string().max(200).optional(),
    content: z.string().max(200).optional(),
    term: z.string().max(200).optional(),
  })
  .strict();

/** `webinar_polls.options`: 2 to 8 options with unique keys. */
export const PollOptions = z
  .array(z.object({ key: z.string().regex(OPTION_KEY), label: LocalizedTextSchema }).strict())
  .min(2)
  .max(8)
  .refine((o) => new Set(o.map((x) => x.key)).size === o.length, { message: "duplicate option key" });

/** `webinar_polls.tag_rules`. */
export const TagRules = z
  .array(
    z
      .object({
        option_keys: z.array(z.string().regex(OPTION_KEY)).min(1),
        tag_key: z.string().min(1).max(80),
        modes: z.array(WatchModeSchema).min(1),
      })
      .strict(),
  )
  .max(32);

const ShowFor = (max: number) => z.number().int().min(15).max(max);
const Consents = z.object({ events: z.boolean().optional(), newsletter: z.boolean().optional() }).strict();

// ---------------------------------------------------------------------------
// Staff actions (section 4.2)
// ---------------------------------------------------------------------------

export const CreateWebinarInput = z.object({
  slug: SlugSchema,
  mode: z.enum(WEBINAR_MODES),
  title: LocalizedTextSchema,
  description: LocalizedTextSchema.default({}),
  locales: WebinarLocalesSchema,
  spokenLocale: LocaleSchema,
  startsAt: z.coerce.date().optional(),
  plannedDurationMinutes: z.number().int().min(5).max(480),
  ownerUserId: uuid,
});

/** Partial settings; `version` is the optimistic lock (edge case 25). */
export const UpdateWebinarInput = z.object({
  webinarId: uuid,
  version: z.number().int().min(1),
  slug: SlugSchema.optional(),
  title: LocalizedTextSchema.optional(),
  description: LocalizedTextSchema.optional(),
  locales: WebinarLocalesSchema.optional(),
  spokenLocale: LocaleSchema.optional(),
  startsAt: z.coerce.date().nullable().optional(),
  plannedDurationMinutes: z.number().int().min(5).max(480).optional(),
  seriesKey: SeriesKeySchema.nullable().optional(),
  isReplayEnabled: z.boolean().optional(),
  isReplayGated: z.boolean().optional(),
  replayUntilAt: z.coerce.date().nullable().optional(),
  replayViewLimit: z.number().int().min(1).max(50).nullable().optional(),
  onDemandAccessDays: z.number().int().min(1).max(365).nullable().optional(),
  attendedMinSec: z.number().int().min(60).max(3600).optional(),
  conversionWindowDays: z.number().int().min(1).max(365).optional(),
  isChatEnabled: z.boolean().optional(),
  isQuestionsEnabled: z.boolean().optional(),
  ownerUserId: uuid.optional(),
  hostMeetUrl: z.string().startsWith("https://meet.google.com/").max(500).nullable().optional(),
});

export const PublishWebinarInput = z.object({ webinarId: uuid, version: z.number().int().min(1) });
export const CancelWebinarInput = z.object({ webinarId: uuid, reason: z.string().trim().min(3).max(500), notify: z.boolean() });
export const ArchiveWebinarInput = z.object({ webinarId: uuid });
export const DuplicateWebinarInput = z.object({
  webinarId: uuid,
  startsAt: z.array(z.coerce.date()).min(1).max(26),
  seriesKey: SeriesKeySchema.optional(),
});
export const SetWebinarVideoInput = z.object({
  webinarId: uuid,
  field: z.enum(["youtube_video_id", "recording_video_id"]),
  videoId: VideoIdSchema,
});

export const UpsertPollInput = z.object({
  webinarId: uuid,
  pollId: uuid.optional(),
  key: ItemKeySchema,
  question: LocalizedTextSchema,
  options: PollOptions,
  allowMultiple: z.boolean().default(false),
  showAtSec: z.number().int().min(0).nullable().optional(),
  showForSec: ShowFor(1800).default(120),
  tagRules: TagRules.default([]),
  sortOrder: z.number().int().min(0).max(1000).default(0),
});
export const DeletePollInput = z.object({ pollId: uuid });

export const UpsertCtaInput = z.object({
  webinarId: uuid,
  ctaId: uuid.optional(),
  key: ItemKeySchema,
  label: LocalizedTextSchema,
  url: z.string().startsWith("https://").max(2000).pipe(z.url()),
  showAtSec: z.number().int().min(0).nullable().optional(),
  showForSec: ShowFor(7200).default(300),
  sortOrder: z.number().int().min(0).max(1000).default(0),
});
export const DeleteCtaInput = z.object({ ctaId: uuid });

/** A staff user (`userId`) or an external presenter by email (crm person, no consent). */
export const UpsertPresenterInput = z
  .object({
    webinarId: uuid,
    presenterId: uuid.optional(),
    userId: uuid.optional(),
    email: z.email().max(254).optional(),
    displayName: z.string().trim().min(1).max(120),
    role: z.enum(PRESENTER_ROLES).default("presenter"),
  })
  .refine((v) => (v.userId === undefined) !== (v.email === undefined), { message: "give exactly one of userId and email" });
export const RemovePresenterInput = z.object({ presenterId: uuid });

export const LaunchPollInput = z.object({ pollId: uuid });
export const ClosePollInput = z.object({ pollId: uuid });
export const ShowCtaInput = z.object({ ctaId: uuid });
export const HideCtaInput = z.object({ ctaId: uuid });

export const ModerateInput = z
  .object({
    webinarId: uuid,
    action: z.enum(MODERATION_ACTIONS),
    interactionId: uuid.optional(),
    registrationId: uuid,
  })
  .refine((v) => !["hide_message", "unhide_message", "mark_answered"].includes(v.action) || v.interactionId !== undefined, {
    message: "message actions need interactionId",
    path: ["interactionId"],
  });

export const ForceLiveStateInput = z.object({ webinarId: uuid, to: z.enum(["live", "ended"]) });

export const RegisterPersonByStaffInput = z.object({ webinarId: uuid, personId: uuid, sendAccessEmail: z.boolean().default(true) });
export const CancelRegistrationByStaffInput = z.object({ registrationId: uuid });
export const RevokeAccessLinkInput = z.object({ registrationId: uuid });
export const ResendAccessLinkInput = z.object({ registrationId: uuid });
export const ExportWebinarRegistrantsInput = z.object({ webinarId: uuid });

// ---------------------------------------------------------------------------
// Customer actions (section 4.2)
// ---------------------------------------------------------------------------

export const RegisterForWebinarInput = z.object({
  webinarId: uuid,
  locale: LocaleSchema,
  consents: Consents.default({}),
  wordingVersion: z.string().min(1).max(80),
});
export const CancelMyRegistrationInput = z.object({ registrationId: uuid });

// ---------------------------------------------------------------------------
// Route bodies (section 4.4)
// ---------------------------------------------------------------------------

/** `POST /api/public/webinars/[slug]/register`; `website` is the honeypot (must stay empty). */
export const PublicRegisterInput = z.object({
  email: z.email().max(254),
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().max(100).optional(),
  locale: LocaleSchema,
  consents: Consents.default({}),
  wordingVersion: z.string().min(1).max(80),
  utm: UtmSchema.default({}),
  website: z.string().max(0).optional(),
});

/** `POST /api/public/webinars/[slug]/join` (lost link). */
export const JoinLinkInput = z.object({ email: z.email().max(254), locale: LocaleSchema, website: z.string().max(0).optional() });

export const ViewInput = z.object({ webinarId: uuid });

export const HeartbeatInput = z.object({
  webinarId: uuid,
  viewId: uuid,
  mode: WatchModeSchema,
  fromSec: z.number().min(0).max(86_400),
  toSec: z.number().min(0).max(86_400),
  state: z.enum(["playing", "paused", "buffering", "ended"]),
});

export const StateQuery = z.object({ webinarId: uuid, after: z.coerce.date().optional() });

const MessageText = z.string().trim().min(1).max(500);
const InteractBase = { webinarId: uuid, viewId: uuid, atSec: z.number().int().min(0).max(86_400).optional() };

export const InteractInput = z.discriminatedUnion("type", [
  z.object({ type: z.literal("poll_answer"), pollId: uuid, optionKeys: z.array(z.string().regex(OPTION_KEY)).min(1).max(8), ...InteractBase }),
  z.object({ type: z.literal("chat"), text: MessageText, ...InteractBase }),
  z.object({ type: z.literal("question"), text: MessageText, ...InteractBase }),
  z.object({ type: z.literal("cta_shown"), ctaId: uuid, ...InteractBase }),
]);

/** `GET /api/webinar/cta/[ctaId]?r&m&s` (rule 36). */
export const CtaClickQuery = z.object({ r: uuid, m: WatchModeSchema, s: z.string().length(22) });

/** The report period (rule 40). */
export const ReportPeriodDays = z.union([z.literal(7), z.literal(14), z.literal(30), z.literal(60), z.literal(90), z.literal(180)]);

export type CreateWebinarInput = z.infer<typeof CreateWebinarInput>;
export type UpdateWebinarInput = z.infer<typeof UpdateWebinarInput>;
export type UpsertPollInput = z.infer<typeof UpsertPollInput>;
export type UpsertCtaInput = z.infer<typeof UpsertCtaInput>;
export type ModerateInput = z.infer<typeof ModerateInput>;
export type PublicRegisterInput = z.infer<typeof PublicRegisterInput>;
export type HeartbeatInput = z.infer<typeof HeartbeatInput>;
export type InteractInput = z.infer<typeof InteractInput>;
export type PollOptions = z.infer<typeof PollOptions>;
export type TagRules = z.infer<typeof TagRules>;
