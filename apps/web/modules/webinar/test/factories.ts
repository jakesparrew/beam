/**
 * webinar test factories (webinar-P1). The factories live in `@beam/db/testing/webinar-factories`
 * since fix-w22-webinar-wiring (forms-P8 request: other modules' tests create webinar rows through
 * the shared factories); this file re-exports them so every webinar test keeps its import.
 *
 * - `makeWebinar(db, overrides?, opts?)`: a draft live webinar starting tomorrow at 19:00 UTC;
 *   `opts.published` makes it publishable for its mode.
 * - `makeRegistration(db, { webinarId, ... })`: a `registered` live registration with a real
 *   access token (`token`).
 * - `makeSegments(db, registration, mode, spans, opts?)`: `watch_segments` rows of one view.
 * - `makePoll`, `makeCta`: an active two-option poll and an https CTA.
 */
export * from "@beam/db/testing/webinar-factories";
