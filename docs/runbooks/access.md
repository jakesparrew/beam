# Runbook: staff access

Owner: BEAM owner (decides), users with `users.manage` (execute). Source: platform spec PL-1 to
PL-18.

## Invite a colleague

1. `/admin/settings/users` → "Invite a colleague": name, email, role, language.
2. The invitation link is valid for 72 hours. The colleague sets a password (at least 12
   characters, zxcvbn score 3, not the email, not in a known breach) and then sets up TOTP MFA.
   MFA is required for every staff account; without it only `/admin/mfa/*` opens.
3. "Resend invitation" on the user page sends a new link when the first one expired.

## Change a role

On `/admin/settings/users/<id>` pick the new role and save. The user is signed out everywhere
(PL-9) and gets the new permissions at the next request. Only an owner may make someone an owner
or change an owner to another role. Nobody can disable or demote the last active owner.

## Leaver

Disable the account the day the colleague leaves ("Disable account"): every session ends at once.
Disabled accounts stay for the audit trail; they are never deleted.

## Lost phone or recovery codes

- Another user with `users.manage` opens the user page and uses "Reset MFA" with a reason
  (`resetUserMfa`). Only an owner can reset another owner's MFA. The user gets a security email
  and sets up MFA again at the next sign-in; all their sessions end.
- **Break glass, the only owner is locked out**: Sidestream runs, with `DATABASE_URL_UNPOOLED`
  of production:

  ```bash
  pnpm admin:reset-mfa --email owner@example.com --reason "Lost phone, confirmed by phone call"
  ```

  It clears MFA, unlocks the account, ends all sessions, writes audit `users.reset_mfa` with actor
  `system` and sends the security email. Confirm the request by phone with the owner before you run
  it, and note it in the monthly report.

## Locked account

Ten failed password or code attempts lock the account for 15 minutes (PL-6). Wait, or use
"Unlock" on the user page.

## Reviews

- Monthly: `/admin/settings/users` — every active account belongs to a current colleague; MFA
  coverage on `/admin/system/security` is 100 %.
- Quarterly: `/admin/settings/roles` — no unknown permission warnings; permissions per role are
  still what BEAM wants (`add-role-permission.md`).

## Customers

Customers sign in with a magic link or a password; they never get staff roles. A customer tester
is marked on `/admin/settings/flags` ("Customer tester").
