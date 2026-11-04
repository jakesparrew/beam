/**
 * `@beam/integrations/youtube`: the YouTube Live and Google Meet client, its fake and types
 * (webinar spec section 6). Jobs build the client through the webinar module's selector, which
 * applies the fake/real rule of runbook section 1.5 with `GOOGLE_OAUTH_REFRESH_TOKEN` as the key.
 */
export * from "./types";
export * from "./fake";
export * from "./client";
