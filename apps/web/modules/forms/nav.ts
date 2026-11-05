/**
 * forms navigation (forms spec section 5; PL-19: an entry renders only when the user holds its
 * permission, the same permission that guards the page). Facade read by `pnpm gen:indexes`.
 * forms-P5 adds "Forms" under Marketing (`forms.write`) and "Fill in a form" under Customers
 * (`persons.write`, the staff-assisted entry page `/admin/forms/enter` of forms-P6). forms-P8 adds
 * the portal entry "My results" (`/account/results`) behind `ff_forms_portal_results` (R2).
 */
export const nav = [
  {
    key: "forms.forms",
    area: "admin",
    section: "marketing",
    labelKey: "forms.nav.forms",
    href: "/admin/forms",
    permission: "forms.write",
    icon: "clipboard-list",
    order: 500,
  },
  {
    key: "forms.enter",
    area: "admin",
    section: "customers",
    labelKey: "forms.nav.enter",
    href: "/admin/forms/enter",
    permission: "persons.write",
    icon: "file-text",
    order: 280,
  },
  {
    key: "forms.my_results",
    area: "portal",
    section: "account",
    labelKey: "forms.nav.my_results",
    href: "/account/results",
    flag: "ff_forms_portal_results",
    icon: "clipboard-list",
    order: 50,
  },
] as const;
