/**
 * forms navigation (forms spec section 5; PL-19: an entry renders only when the user holds its
 * permission, the same permission that guards the page). Facade read by `pnpm gen:indexes`.
 * forms-P5 adds "Forms" under Marketing (`forms.write`) and "Fill in a form" under Customers
 * (`persons.write`, the staff-assisted entry page `/admin/forms/enter` of forms-P6).
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
] as const;
