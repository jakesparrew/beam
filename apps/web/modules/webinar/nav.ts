/**
 * webinar navigation (PL-19: an entry renders only when the user holds its permission, the same
 * permission that guards the page). Facade read by `pnpm gen:indexes`: `key` and `area` are
 * literals. webinar-P2 adds the staff entry "Webinars" (`/admin/webinars`, `webinars.host`);
 * webinar-P3 adds the portal entry "Webinars" (`/account/webinars`) behind `ff_webinar_portal`.
 */
export const nav = [
  {
    key: "webinar.webinars",
    area: "admin",
    section: "webinar",
    labelKey: "webinar.nav.webinars",
    href: "/admin/webinars",
    permission: "webinars.host",
    icon: "video",
    order: 100,
  },
  {
    key: "webinar.my_webinars",
    area: "portal",
    section: "webinar",
    labelKey: "webinar.nav.my_webinars",
    href: "/account/webinars",
    flag: "ff_webinar_portal",
    icon: "video",
    order: 60,
  },
] as const;
