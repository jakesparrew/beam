/**
 * automation permissions (architecture section 4, automation spec 7, 02-data-model 5.3). Facade
 * read by `pnpm gen:indexes`: the architecture's three strings, no new permission. Reading uses
 * `reports.read` or `automations.write`; person data additionally needs `persons.read`.
 */
export const permissions = [
  "automations.write",
  "automations.publish",
  "automations.move_person",
] as const;
