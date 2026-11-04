/**
 * webinar types named in the cross-module contract (02-data-model section 6.12) and the shapes
 * the pure rules of `@beam/core/webinar` take (webinar spec sections 2 and 3). Owned by webinar
 * from webinar-P1 on (R2); the value lists equal the `pgEnum`s of `@beam/db/schema` webinar.
 */
export const WATCH_MODES = ["live", "replay", "on_demand"] as const;
export type WatchMode = (typeof WATCH_MODES)[number];

export const WEBINAR_MODES = ["live", "simulive", "on_demand"] as const;
export type WebinarMode = (typeof WEBINAR_MODES)[number];

export const WEBINAR_STATUSES = ["draft", "published", "live", "ended", "cancelled", "archived"] as const;
export type WebinarStatus = (typeof WEBINAR_STATUSES)[number];

export const PRESENTER_ROLES = ["host", "presenter", "moderator"] as const;
export type PresenterRole = (typeof PRESENTER_ROLES)[number];

export const REGISTRATION_STATUSES = ["registered", "cancelled", "blocked"] as const;
export type RegistrationStatus = (typeof REGISTRATION_STATUSES)[number];

export const REGISTRATION_SOURCES = ["site", "portal", "admin", "automation"] as const;
export type RegistrationSource = (typeof REGISTRATION_SOURCES)[number];

export const PERSON_STATUS_SNAPSHOTS = ["lead", "customer", "member"] as const;
export type PersonStatusSnapshot = (typeof PERSON_STATUS_SNAPSHOTS)[number];

/** Exactly the architecture list (section 2.1). */
export const INTERACTION_KINDS = ["started", "poll_answer", "cta_shown", "cta_clicked", "chat", "question", "ended"] as const;
export type InteractionKind = (typeof INTERACTION_KINDS)[number];

export const MODERATION_ACTIONS = [
  "hide_message",
  "unhide_message",
  "mark_answered",
  "mute_viewer",
  "unmute_viewer",
  "block_viewer",
  "unblock_viewer",
] as const;
export type ModerationAction = (typeof MODERATION_ACTIONS)[number];
/** Moderation actions about one message (they need `interaction_id`). */
export const MESSAGE_MODERATION_ACTIONS = ["hide_message", "unhide_message", "mark_answered"] as const satisfies readonly ModerationAction[];

/** Watch facts per registration per mode, in the order they are reached (rule 27). */
export const WATCH_FACTS = ["attended", "15m", "30m", "50pct", "end"] as const;
export type WatchFact = (typeof WATCH_FACTS)[number];
/** The `data.threshold` values of `webinar.watched` (every fact but `attended`). */
export type WatchThreshold = Exclude<WatchFact, "attended">;

/** Fixed numbers of rules 22-31. */
export const WEBINAR_LIMITS = {
  /** `15m` threshold (seconds watched in one mode). */
  watched15mSec: 900,
  /** `30m` threshold. */
  watched30mSec: 1800,
  /** `end` is reached at `duration_sec - endMarginSec` (edge case 3). */
  endMarginSec: 60,
  /** Default `attended_min_sec`. */
  attendedMinSecDefault: 300,
  /** The player's heartbeat interval. */
  heartbeatSec: 15,
  /** A heartbeat of one view sooner than this after its previous one is rejected (429). */
  minHeartbeatSpacingSec: 10,
  /** A segment never spans more than this (`watch_segments` check). */
  maxSegmentSec: 30,
  /** Replay spans may exceed the wall time since the previous heartbeat by this much. */
  replaySlackSec: 5,
  /** The player shows a countdown before `starts_at - countdownLeadMin`. */
  countdownLeadMin: 15,
  /** A replay or on-demand view counts when no `started` of the same mode exists in this window. */
  viewDedupeMin: 30,
} as const;

/** The webinar columns the mode and access rules read (a `webinars` row satisfies it). */
export type WebinarState = {
  mode: WebinarMode;
  status: WebinarStatus;
  startsAt: Date | null;
  plannedDurationMinutes: number;
  durationSec: number | null;
  liveStartedAt: Date | null;
  liveEndedAt: Date | null;
  recordingVideoId: string | null;
  isReplayEnabled: boolean;
  isReplayGated: boolean;
  replayUntilAt: Date | null;
  replayViewLimit: number | null;
  onDemandAccessDays: number | null;
};

/** The registration columns the access rules read. `createdAt` is the registration time. */
export type RegistrationState = {
  createdAt: Date;
  registeredMode: WatchMode;
  status: RegistrationStatus;
};

/** `webinar_registrations.utm`. */
export type Utm = { source?: string; medium?: string; campaign?: string; content?: string; term?: string };

/** One entry of `webinar_polls.tag_rules`. */
export type PollTagRule = { option_keys: string[]; tag_key: string; modes: WatchMode[] };

/** The poll columns the answer rules read. */
export type PollDefinition = {
  key: string;
  options: ReadonlyArray<{ key: string }>;
  allowMultiple: boolean;
  tagRules: readonly PollTagRule[];
};

/** A poll or CTA that appears at a video position (replay, simulive, on-demand; rule 34). */
export type TimedItem = { showAtSec: number | null; showForSec: number; isActive?: boolean };
