# Runbook: add or change a role permission

Owner: BEAM owner (decides), users with `users.manage` (execute); developers (new permissions).
Source: platform spec PL-15 to PL-19, PL-80.

## Grant or remove a permission for a role (no deploy)

1. `/admin/settings/roles` → pick the role.
2. Tick or untick permissions; each has a description and is grouped by module.
3. "Review changes" shows what is added and removed; confirm. Audit `roles.update_permissions`
   keeps the old and new list.
4. The change applies at each user's next request (no cache, PL-17).

Rules enforced by the server:
- Only an owner may add `persons.sensitive_read` (sensitive health data) to a role.
- The owner role is read-only and always holds every permission (`*`), including later ones.
- A permission that does not exist in the registry is refused (PL-18).

## A new permission in code (developers)

1. Declare it in the module's `apps/web/modules/<m>/permissions.ts` with a literal key
   `<module>.<action>` and its default roles; run `pnpm gen:indexes`.
2. Add its description to the module catalogue in all three languages:
   `<m>.permissions.<module>_<action>`.
3. Use it in `action({ permission })` and in the nav entry (`nav.ts`).
4. On deploy, the defaults seed grants it to its default roles once
   (`grantDefaultPermission`, recorded in `roles.seeded_permissions`). A permission an owner later
   removes is never granted again by a deploy (PL-80).

## A permission removed from code

It disappears from the registry; roles that still hold it show a warning on
`/admin/settings/roles` and the string is ignored at runtime. Open the role and save it once to
drop the stale string.
