/**
 * forms navigation (forms spec section 5; PL-19: an entry renders only when the user holds its
 * permission, the same permission that guards the page). Facade read by `pnpm gen:indexes`.
 * forms-P5 adds "Forms" under Marketing (`forms.write`) and "Fill in a form" under Customers
 * (`persons.write`, the staff-assisted entry page `/admin/forms/enter` of forms-P6). forms-P8 adds
 * the portal entry "My results" (`/account/results`) behind `ff_forms_portal_results` (R2) and,
 * for forms-P7's request, "Form imports" under Marketing (`/admin/forms/imports`, `forms.publish`,
 * the permission of the import pages). fix-w21-forms-wiring adds "Attribution" under Marketing
 * (`/admin/forms/attribution` of forms-P9, `reports.read`: the page opens for `reports.read` or
 * `forms.write`, and every role that holds `forms.write` also holds `reports.read`).
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
    key: "forms.attribution",
    area: "admin",
    section: "marketing",
    labelKey: "forms.nav.attribution",
    href: "/admin/forms/attribution",
    permission: "reports.read",
    icon: "chart-bar",
    order: 505,
  },
  {
    key: "forms.imports",
    area: "admin",
    section: "marketing",
    labelKey: "forms.nav.imports",
    href: "/admin/forms/imports",
    permission: "forms.publish",
    icon: "file-input",
    order: 510,
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
