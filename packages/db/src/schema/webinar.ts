/**
 * webinar schema (webinar spec section 2.3, data model 1.2.12). Replaces the Wave 0 stub of
 * platform-P2 in webinar-P1 (R2): every R2 enum, table, check and index of the module. Later
 * webinar packages only read this file (it is edited by webinar-P1 alone).
 *
 * APPEND tables: `watch_segments`, `webinar_interactions` and `webinar_moderation_actions`
 * (already in Wave 0's `APPEND_ONLY_TABLES`; their `reject_update_delete()` triggers come from
 * `select beam_protect_append_only();`). Erasure and the retention sweeps delete them under
 * `SET LOCAL beam.allow_rewrite = 'on'`, mostly by cascade from `webinar_registrations`.
 *
 * Foreign keys point only at this module's tables and the Wave 0 contract tables `sessions`,
 * `persons` and `users`; `sessions.webinar_id` on the booking side is a plain uuid (booking
 * spec), so there is no import cycle.
 *
 * Read contract for forms (section 2.3): `webinars.id`, `slug` and `status` stay stable.
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  smallint,
  text,
  unique,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { sessions } from "./booking";
import { persons } from "./crm";
import { users } from "./platform";
import { createdAt, id, localeEnum, localized, timestamps, tstz, type LocalizedText } from "./_shared";

// ---------------------------------------------------------------------------
// Enums (section 2.1)
// ---------------------------------------------------------------------------

/** One shared list for `watch_segments_mode`, `webinar_interactions_mode` and the registered mode. */
const WATCH_MODE_VALUES = ["live", "replay", "on_demand"] as const;

export const webinarsMode = pgEnum("webinars_mode", ["live", "simulive", "on_demand"]);
export const webinarsStatus = pgEnum("webinars_status", ["draft", "published", "live", "ended", "cancelled", "archived"]);
export const webinarPresentersRole = pgEnum("webinar_presenters_role", ["host", "presenter", "moderator"]);
export const webinarRegistrationsRegisteredMode = pgEnum("webinar_registrations_registered_mode", WATCH_MODE_VALUES);
export const webinarRegistrationsStatus = pgEnum("webinar_registrations_status", ["registered", "cancelled", "blocked"]);
export const webinarRegistrationsSource = pgEnum("webinar_registrations_source", ["site", "portal", "admin", "automation"]);
export const webinarRegistrationsPersonStatus = pgEnum("webinar_registrations_person_status", ["lead", "customer", "member"]);
export const watchSegmentsMode = pgEnum("watch_segments_mode", WATCH_MODE_VALUES);
export const webinarInteractionsMode = pgEnum("webinar_interactions_mode", WATCH_MODE_VALUES);
export const webinarInteractionsKind = pgEnum("webinar_interactions_kind", [
  "started",
  "poll_answer",
  "cta_shown",
  "cta_clicked",
  "chat",
  "question",
  "ended",
]);
export const webinarModerationActionsAction = pgEnum("webinar_moderation_actions_action", [
  "hide_message",
  "unhide_message",
  "mark_answered",
  "mute_viewer",
  "unmute_viewer",
  "block_viewer",
  "unblock_viewer",
]);

/** Moderation actions that target one message and therefore need `interaction_id`. */
export const WEBINAR_MESSAGE_ACTIONS = ["hide_message", "unhide_message", "mark_answered"] as const;

/** `webinar_polls.options`: 2 to 8 options (validated by Zod `PollOptions` in `@beam/core/webinar`). */
export type WebinarPollOptionJson = { key: string; label: LocalizedText };
/** `webinar_polls.tag_rules`. */
export type WebinarTagRuleJson = { option_keys: string[]; tag_key: string; modes: Array<(typeof WATCH_MODE_VALUES)[number]> };
/** `webinar_registrations.utm`. */
export type WebinarUtmJson = { source?: string; medium?: string; campaign?: string; content?: string; term?: string };

// ---------------------------------------------------------------------------
// webinars
// ---------------------------------------------------------------------------

/** Mutable, optimistic `version`. */
export const webinars = pgTable(
  "webinars",
  {
    id: id(),
    slug: text().notNull(),
    sessionId: uuid().references(() => sessions.id, { onDelete: "restrict" }),
    seriesKey: text(),
    title: localized().notNull(),
    description: localized().notNull().default({}),
    locales: text()
      .array()
      .$type<Array<"nl-BE" | "fr-BE" | "en">>()
      .notNull()
      .default(sql`'{nl-BE,fr-BE,en}'::text[]`),
    spokenLocale: localeEnum().notNull().default("nl-BE"),
    mode: webinarsMode().notNull(),
    status: webinarsStatus().notNull().default("draft"),
    startsAt: tstz(),
    plannedDurationMinutes: smallint().notNull().default(60),
    /** Real length from YouTube (recording) or the simulive video. */
    durationSec: integer(),
    /** Live broadcast id (= video id). */
    youtubeVideoId: text(),
    youtubeStreamId: text(),
    /** Last `lifeCycleStatus` seen (`created`, `ready`, `testing`, `live`, `complete`, `revoked`). */
    youtubeLifecycle: text(),
    /** VOD for replay, simulive and on-demand. */
    recordingVideoId: text(),
    hostMeetUrl: text(),
    meetSpaceName: text(),
    publishRequestedAt: tstz(),
    broadcastError: text(),
    publishedAt: tstz(),
    liveStartedAt: tstz(),
    liveEndedAt: tstz(),
    finalisedAt: tstz(),
    isReplayEnabled: boolean().notNull().default(true),
    isReplayGated: boolean().notNull().default(true),
    replayUntilAt: tstz(),
    replayViewLimit: smallint(),
    onDemandAccessDays: smallint(),
    attendedMinSec: integer().notNull().default(300),
    conversionWindowDays: smallint().notNull().default(30),
    isChatEnabled: boolean().notNull().default(true),
    isQuestionsEnabled: boolean().notNull().default(true),
    ownerUserId: uuid()
      .notNull()
      .references(() => users.id),
    createdByUserId: uuid()
      .notNull()
      .references(() => users.id),
    cancelledReason: text(),
    version: integer().notNull().default(1),
    ...timestamps(),
  },
  (t) => [
    unique("webinars_slug_uq").on(t.slug),
    unique("webinars_session_uq").on(t.sessionId),
    check("webinars_slug_ck", sql`${t.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(${t.slug}) <= 80`),
    check("webinars_series_key_ck", sql`${t.seriesKey} ~ '^[a-z0-9-]{3,60}$'`),
    check(
      "webinars_locales_ck",
      sql`${t.locales} <@ array['nl-BE','fr-BE','en']::text[] and cardinality(${t.locales}) >= 1`,
    ),
    check("webinars_starts_at_ck", sql`${t.mode} <> 'on_demand' or ${t.startsAt} is null`),
    check("webinars_planned_duration_ck", sql`${t.plannedDurationMinutes} between 5 and 480`),
    check("webinars_duration_sec_ck", sql`${t.durationSec} > 0`),
    check("webinars_youtube_video_id_ck", sql`${t.youtubeVideoId} ~ '^[A-Za-z0-9_-]{11}$'`),
    check("webinars_recording_video_id_ck", sql`${t.recordingVideoId} ~ '^[A-Za-z0-9_-]{11}$'`),
    check("webinars_host_meet_url_ck", sql`${t.hostMeetUrl} like 'https://meet.google.com/%'`),
    check(
      "webinars_replay_until_ck",
      sql`${t.replayUntilAt} is null or ${t.startsAt} is null or ${t.replayUntilAt} > ${t.startsAt}`,
    ),
    check("webinars_replay_view_limit_ck", sql`${t.replayViewLimit} between 1 and 50`),
    check("webinars_on_demand_access_days_ck", sql`${t.onDemandAccessDays} between 1 and 365`),
    check("webinars_attended_min_sec_ck", sql`${t.attendedMinSec} between 60 and 3600`),
    check("webinars_conversion_window_days_ck", sql`${t.conversionWindowDays} between 1 and 365`),
    check(
      "ck_webinars_scheduled",
      sql`${t.status} in ('draft','cancelled') or ${t.mode} = 'on_demand' or (${t.startsAt} is not null and ${t.sessionId} is not null)`,
    ),
    check("ck_webinars_video", sql`${t.status} = 'draft' or ${t.mode} = 'live' or ${t.recordingVideoId} is not null`),
    check(
      "ck_webinars_live_video",
      sql`${t.status} in ('draft','cancelled') or ${t.mode} <> 'live' or ${t.youtubeVideoId} is not null`,
    ),
    index("webinars_status_starts_idx").on(t.status, t.startsAt),
    index("webinars_series_key_idx")
      .on(t.seriesKey)
      .where(sql`${t.seriesKey} is not null`),
    index("webinars_mode_status_idx")
      .on(t.mode, t.status)
      .where(sql`${t.status} in ('published','live','ended')`),
  ],
);

// ---------------------------------------------------------------------------
// webinar_presenters
// ---------------------------------------------------------------------------

/** A staff user or a CRM person (principle 1: no identity outside `persons`/`users`). */
export const webinarPresenters = pgTable(
  "webinar_presenters",
  {
    id: id(),
    webinarId: uuid()
      .notNull()
      .references(() => webinars.id, { onDelete: "cascade" }),
    userId: uuid().references(() => users.id),
    personId: uuid().references(() => persons.id),
    displayName: text().notNull(),
    role: webinarPresentersRole().notNull().default("presenter"),
    sortOrder: smallint().notNull().default(0),
    ...timestamps(),
  },
  (t) => [
    check("webinar_presenters_identity_ck", sql`num_nonnulls(${t.userId}, ${t.personId}) = 1`),
    check("webinar_presenters_display_name_ck", sql`length(${t.displayName}) between 1 and 120`),
    uniqueIndex("webinar_presenters_user_uq")
      .on(t.webinarId, t.userId)
      .where(sql`${t.userId} is not null`),
    uniqueIndex("webinar_presenters_person_uq")
      .on(t.webinarId, t.personId)
      .where(sql`${t.personId} is not null`),
    index("webinar_presenters_person_idx")
      .on(t.personId)
      .where(sql`${t.personId} is not null`),
  ],
);

// ---------------------------------------------------------------------------
// webinar_registrations
// ---------------------------------------------------------------------------

/** Mutable status; one per person per webinar. `created_at` is the registration time. */
export const webinarRegistrations = pgTable(
  "webinar_registrations",
  {
    id: id(),
    webinarId: uuid()
      .notNull()
      .references(() => webinars.id, { onDelete: "restrict" }),
    personId: uuid()
      .notNull()
      .references(() => persons.id, { onDelete: "restrict" }),
    /** `sha256(token)` hex (rule 19); the raw token is never stored. */
    accessTokenHash: text().notNull(),
    tokenVersion: smallint().notNull().default(1),
    registeredMode: webinarRegistrationsRegisteredMode().notNull(),
    status: webinarRegistrationsStatus().notNull().default("registered"),
    source: webinarRegistrationsSource().notNull(),
    locale: localeEnum().notNull(),
    /** Snapshot of `crm.getPersonStatus` at registration (rule 16). */
    personStatus: webinarRegistrationsPersonStatus().notNull(),
    utm: jsonb().$type<WebinarUtmJson>().notNull().default({}),
    accessEmailsSent: smallint().notNull().default(0),
    lastAccessEmailAt: tstz(),
    cancelledAt: tstz(),
    blockedAt: tstz(),
    blockedByUserId: uuid().references(() => users.id),
    mutedAt: tstz(),
    mutedByUserId: uuid().references(() => users.id),
    ...timestamps(),
  },
  (t) => [
    unique("webinar_registrations_webinar_person_uq").on(t.webinarId, t.personId),
    unique("webinar_registrations_token_hash_uq").on(t.accessTokenHash),
    index("webinar_registrations_person_idx").on(t.personId),
    index("webinar_registrations_webinar_status_idx").on(t.webinarId, t.status),
    index("webinar_registrations_webinar_person_status_idx").on(t.webinarId, t.personStatus),
    check("webinar_registrations_blocked_ck", sql`${t.status} <> 'blocked' or ${t.blockedAt} is not null`),
    check("webinar_registrations_cancelled_ck", sql`${t.status} <> 'cancelled' or ${t.cancelledAt} is not null`),
    check("webinar_registrations_token_version_ck", sql`${t.tokenVersion} >= 1`),
    check("webinar_registrations_access_emails_ck", sql`${t.accessEmailsSent} >= 0`),
  ],
);

// ---------------------------------------------------------------------------
// webinar_polls, webinar_ctas
// ---------------------------------------------------------------------------

/** Mutable until answered; then only `is_active` and `live_*` change. */
export const webinarPolls = pgTable(
  "webinar_polls",
  {
    id: id(),
    webinarId: uuid()
      .notNull()
      .references(() => webinars.id, { onDelete: "cascade" }),
    key: text().notNull(),
    question: localized().notNull(),
    options: jsonb().$type<WebinarPollOptionJson[]>().notNull(),
    allowMultiple: boolean().notNull().default(false),
    /** Position where replay, simulive and on-demand show it. */
    showAtSec: integer(),
    showForSec: integer().notNull().default(120),
    liveLaunchedAt: tstz(),
    liveClosedAt: tstz(),
    tagRules: jsonb().$type<WebinarTagRuleJson[]>().notNull().default([]),
    isActive: boolean().notNull().default(true),
    sortOrder: smallint().notNull().default(0),
    ...timestamps(),
  },
  (t) => [
    unique("webinar_polls_webinar_key_uq").on(t.webinarId, t.key),
    check("webinar_polls_key_ck", sql`${t.key} ~ '^[a-z0-9_]{1,40}$'`),
    check(
      "webinar_polls_options_ck",
      sql`jsonb_typeof(${t.options}) = 'array' and jsonb_array_length(${t.options}) between 2 and 8`,
    ),
    check("webinar_polls_tag_rules_ck", sql`jsonb_typeof(${t.tagRules}) = 'array'`),
    check("webinar_polls_show_at_ck", sql`${t.showAtSec} >= 0`),
    check("webinar_polls_show_for_ck", sql`${t.showForSec} between 15 and 1800`),
  ],
);

/** Same lifecycle as polls. */
export const webinarCtas = pgTable(
  "webinar_ctas",
  {
    id: id(),
    webinarId: uuid()
      .notNull()
      .references(() => webinars.id, { onDelete: "cascade" }),
    key: text().notNull(),
    label: localized().notNull(),
    url: text().notNull(),
    showAtSec: integer(),
    showForSec: integer().notNull().default(300),
    liveShownAt: tstz(),
    liveHiddenAt: tstz(),
    isActive: boolean().notNull().default(true),
    sortOrder: smallint().notNull().default(0),
    ...timestamps(),
  },
  (t) => [
    unique("webinar_ctas_webinar_key_uq").on(t.webinarId, t.key),
    check("webinar_ctas_key_ck", sql`${t.key} ~ '^[a-z0-9_]{1,40}$'`),
    check("webinar_ctas_url_ck", sql`${t.url} like 'https://%' and length(${t.url}) <= 2000`),
    check("webinar_ctas_show_at_ck", sql`${t.showAtSec} >= 0`),
    check("webinar_ctas_show_for_ck", sql`${t.showForSec} between 15 and 7200`),
  ],
);

// ---------------------------------------------------------------------------
// watch_segments (APPEND)
// ---------------------------------------------------------------------------

/** One row per accepted heartbeat. Positions are seconds from the start of the video. */
export const watchSegments = pgTable(
  "watch_segments",
  {
    id: id(),
    registrationId: uuid()
      .notNull()
      .references(() => webinarRegistrations.id, { onDelete: "cascade" }),
    /** Denormalised for reporting indexes. */
    webinarId: uuid()
      .notNull()
      .references(() => webinars.id),
    mode: watchSegmentsMode().notNull(),
    /** One player view (page load to close). */
    viewId: uuid().notNull(),
    fromSec: integer().notNull(),
    toSec: integer().notNull(),
    recordedAt: tstz().notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [
    check("watch_segments_from_ck", sql`${t.fromSec} >= 0`),
    check("watch_segments_span_ck", sql`${t.toSec} > ${t.fromSec} and ${t.toSec} - ${t.fromSec} <= 30`),
    index("watch_segments_registration_mode_idx").on(t.registrationId, t.mode, t.fromSec),
    index("watch_segments_webinar_mode_idx").on(t.webinarId, t.mode, t.recordedAt),
    index("watch_segments_recorded_idx").on(t.recordedAt),
  ],
);

// ---------------------------------------------------------------------------
// webinar_interactions (APPEND)
// ---------------------------------------------------------------------------

/**
 * Every viewer action with its mode (scenario 5). `payload`: `poll_answer` `{option_keys}`;
 * `chat`/`question` `{text}` (1-500 chars, personal data, never in AI context or segments);
 * `started` `{player_notice_version}`; `cta_clicked` `{url}`.
 */
export const webinarInteractions = pgTable(
  "webinar_interactions",
  {
    id: id(),
    registrationId: uuid()
      .notNull()
      .references(() => webinarRegistrations.id, { onDelete: "cascade" }),
    webinarId: uuid()
      .notNull()
      .references(() => webinars.id),
    mode: webinarInteractionsMode().notNull(),
    kind: webinarInteractionsKind().notNull(),
    pollId: uuid().references(() => webinarPolls.id),
    ctaId: uuid().references(() => webinarCtas.id),
    viewId: uuid(),
    payload: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    atSec: integer(),
    occurredAt: tstz().notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [
    check("webinar_interactions_poll_ck", sql`(${t.kind} = 'poll_answer') = (${t.pollId} is not null)`),
    check("webinar_interactions_cta_ck", sql`(${t.kind} in ('cta_shown','cta_clicked')) = (${t.ctaId} is not null)`),
    check("webinar_interactions_at_sec_ck", sql`${t.atSec} >= 0`),
    check(
      "webinar_interactions_text_ck",
      sql`${t.kind} not in ('chat','question') or char_length(coalesce(${t.payload}->>'text', '')) between 1 and 500`,
    ),
    uniqueIndex("uq_poll_answer_once")
      .on(t.registrationId, t.pollId, t.mode)
      .where(sql`${t.kind} = 'poll_answer'`),
    uniqueIndex("uq_cta_shown_once")
      .on(t.registrationId, t.ctaId, t.mode)
      .where(sql`${t.kind} = 'cta_shown'`),
    index("webinar_interactions_webinar_kind_mode_idx").on(t.webinarId, t.kind, t.mode),
    index("webinar_interactions_messages_idx")
      .on(t.webinarId, t.occurredAt)
      .where(sql`${t.kind} in ('chat','question')`),
    index("webinar_interactions_registration_kind_mode_idx").on(t.registrationId, t.kind, t.mode),
    index("webinar_interactions_occurred_idx").on(t.occurredAt),
  ],
);

// ---------------------------------------------------------------------------
// webinar_moderation_actions (APPEND)
// ---------------------------------------------------------------------------

/** The current visibility of a message is its latest `hide_message`/`unhide_message` row. */
export const webinarModerationActions = pgTable(
  "webinar_moderation_actions",
  {
    id: id(),
    webinarId: uuid()
      .notNull()
      .references(() => webinars.id),
    interactionId: uuid().references((): AnyPgColumn => webinarInteractions.id, { onDelete: "cascade" }),
    registrationId: uuid()
      .notNull()
      .references(() => webinarRegistrations.id, { onDelete: "cascade" }),
    action: webinarModerationActionsAction().notNull(),
    byUserId: uuid()
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    check(
      "webinar_moderation_actions_message_ck",
      sql`${t.action} not in ('hide_message','unhide_message','mark_answered') or ${t.interactionId} is not null`,
    ),
    index("webinar_moderation_actions_webinar_created_idx").on(t.webinarId, t.createdAt),
    index("webinar_moderation_actions_registration_idx").on(t.registrationId),
  ],
);
