# User roles and permissions

Every staff user has exactly **one role**. A role is a list of **permissions**, such as
`bookings.write` ("create and change bookings"). The server checks the permission before any
change, and the menu hides what a role may not open, so the screens and the server always agree.
Customers are not staff: they have their own account and only ever see their own data.

## The nine roles

| Role | Dutch name in the app | Meant for | In short |
| --- | --- | --- | --- |
| `owner` | Eigenaar | BEAM's owner | Everything, including permissions added later, and the only role that reads sensitive health data by default |
| `technical_admin` | Technisch beheerder | George (BEAM) and Sidestream | Everything except reading sensitive data |
| `management` | Directie | BEAM management | Everything except user management, system jobs, privacy requests and sensitive data |
| `customer_service` | Klantenservice | Customer service | Customers, bookings, waitlists, credits, memberships, tasks |
| `sales` | Verkoop | Sales | Customers, selling at the counter, tasks, B2B (Release 3) |
| `marketing` | Marketing | Marketing | Forms, email, campaigns, automations, website, webinars |
| `finance` | Financiën | Finance and the accountant | Invoices, refunds, prices, financial reports |
| `reception` | Onthaal | Front desk | Customers, bookings, waitlist, the till (POS), credits |
| `external_partner` | Externe partner | A partner company (Release 3) | Only their own partner figures, no customer data |

## Default permissions

This is what each role gets when the platform is first set up (seed `packages/db/src/seed/platform.ts`,
table `DEFAULT_ROLE_GRANTS`, and architecture section 4). The owner role always holds every
permission (`*`). Every other role can be changed afterwards (see "Changing a role" below).

| Permission | owner | technical_admin | management | customer_service | sales | marketing | finance | reception | external_partner |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `ai.use` | yes | yes | yes | – | yes | yes | – | – | – |
| `automations.move_person` | yes | yes | yes | – | – | yes | – | – | – |
| `automations.publish` | yes | yes | yes | – | – | yes | – | – | – |
| `automations.write` | yes | yes | yes | – | – | yes | – | – | – |
| `bookings.override` | yes | yes | yes | – | – | – | – | – | – |
| `bookings.read` | yes | yes | yes | yes | yes | – | – | yes | – |
| `bookings.write` | yes | yes | yes | yes | – | – | – | yes | – |
| `campaigns.send` | yes | yes | yes | – | – | yes | – | – | – |
| `commerce.refund` | yes | yes | yes | – | – | – | yes | – | – |
| `commerce.sell` | yes | yes | yes | – | yes | – | – | yes | – |
| `credits.adjust` | yes | yes | yes | yes | – | – | – | – | – |
| `credits.read` | yes | yes | yes | yes | – | – | yes | yes | – |
| `dashboards.manage` | yes | yes | yes | – | – | – | – | – | – |
| `email.send` | yes | yes | yes | – | – | yes | – | – | – |
| `email.write` | yes | yes | yes | yes | – | yes | – | – | – |
| `flags.manage` | yes | yes | yes | – | – | – | – | – | – |
| `forms.publish` | yes | yes | yes | – | – | yes | – | – | – |
| `forms.write` | yes | yes | yes | – | – | yes | – | – | – |
| `invoices.issue` | yes | yes | yes | – | – | – | yes | – | – |
| `invoices.read` | yes | yes | yes | – | – | – | yes | – | – |
| `memberships.write` | yes | yes | yes | yes | – | – | – | – | – |
| `partner.own` | yes | yes | yes | – | – | – | – | – | yes |
| `persons.erase` | yes | yes | yes | – | – | – | – | – | – |
| `persons.export` | yes | yes | yes | – | – | – | – | – | – |
| `persons.merge` | yes | yes | yes | yes | – | – | – | – | – |
| `persons.read` | yes | yes | yes | yes | yes | yes | yes | yes | – |
| `persons.sensitive_read` | yes | – | – | – | – | – | – | – | – |
| `persons.write` | yes | yes | yes | yes | yes | – | – | yes | – |
| `pricing.write` | yes | yes | yes | – | – | – | yes | – | – |
| `privacy.run` | yes | yes | – | – | – | – | – | – | – |
| `referrals.manage` | yes | yes | yes | – | yes | – | yes | – | – |
| `reports.finance` | yes | yes | yes | – | – | – | yes | – | – |
| `reports.read` | yes | yes | yes | yes | yes | yes | yes | – | – |
| `settings.write` | yes | yes | yes | – | – | – | – | – | – |
| `site.edit` | yes | yes | yes | – | – | yes | – | – | – |
| `site.publish` | yes | yes | yes | – | – | yes | – | – | – |
| `system.jobs` | yes | yes | – | – | – | – | – | – | – |
| `tasks.all` | yes | yes | yes | yes | yes | – | – | yes | – |
| `users.manage` | yes | yes | – | – | – | – | – | – | – |
| `waitlist.manage` | yes | yes | yes | yes | – | – | – | yes | – |
| `webinars.host` | yes | yes | yes | – | – | yes | – | – | – |

Release 3 adds `crm.b2b` (sales and the three top roles). A permission that a later release adds
reaches `technical_admin` and `management` automatically on the next deploy, unless it is one of
their exclusions.

### What some permissions mean

| Permission | Allows |
| --- | --- |
| `bookings.override` | Booking past capacity, cancelling outside the rules with a refund, cancelling a whole session, creating events |
| `credits.adjust` | Adding, removing, extending or transferring credits (always with a reason) |
| `commerce.refund` | Refunds. A refund above €500, or on an order older than a year, also needs `invoices.issue` |
| `persons.merge` | Merging two customer records |
| `persons.export` / `persons.erase` | Staff exports of customer data, and starting an erasure |
| `privacy.run` | Running GDPR requests (export and erasure) |
| `automations.move_person` | Stopping, starting or moving a person's journey from the person page |
| `system.jobs` | The System pages: jobs, webhooks, the support register, the monthly report |
| `settings.write` | Business settings such as cancellation rules and opening hours |
| `flags.manage` | Turning features on for testers or for everyone |
| `users.manage` | Inviting, disabling and changing staff users |

## Changing a role

- **Give or remove a permission for a role:** an owner opens `/admin/settings/roles`, ticks or
  unticks, and saves. No deploy is needed. Every change is in the audit log
  (`roles.update_permissions`). Step by step: [docs/runbooks/add-role-permission.md](../runbooks/add-role-permission.md).
- **Change a person's role, invite a colleague, handle a leaver or a lost phone:**
  `/admin/settings/users` (`users.manage`). Step by step: [docs/runbooks/access.md](../runbooks/access.md).
- A permission the owner removed is never given back by a later deploy. The seed remembers what
  it already granted once (`roles.seeded_permissions`).
- Only an owner may give `persons.sensitive_read` to a role, make someone owner or take the owner
  role away. Nobody can disable or demote the last active owner.
- A change applies on the person's next click; there is no cache.
- New permission names can only come from code. A developer declares them in the module's
  `permissions.ts`.

## Sign-in and sessions

| | Staff | Customers |
| --- | --- | --- |
| How | Email and password, then a 6-digit code from an authenticator app (MFA, required for everyone) | A sign-in link by email (valid 15 minutes, used once); a password is optional |
| Password rules | At least 12 characters, strong enough (zxcvbn score 3 or more), not the email, not in a known data breach | At least 10 characters, zxcvbn score 2 or more, not in a known data breach |
| Lock-out | 10 wrong attempts lock the account for 15 minutes | Sign-in links are limited to 5 per address per hour |
| Session length | Ends after 12 hours without activity, and after 7 days at most | 90 days |
| Recovery | 10 single-use recovery codes, shown once at MFA set-up | A new sign-in link |

An owner or technical_admin can end any staff session and reset someone's MFA from
`/admin/settings/users`. Every one of these steps is audited.

## Sensitive data

Health-related information (health notes, sleep, stress, recovery, wellbeing, medical, and form
answers marked sensitive) is special-category data under GDPR. The platform treats it like this:

- It is stored in only three places, encrypted (see [database.md](database.md#sensitive-columns)).
- Only roles with `persons.sensitive_read` see it. **By default that is only the owner.** The owner
  can give it to another role on `/admin/settings/roles`; do this only for people who need it for
  their work, and record why.
- Every time someone opens a sensitive value, the audit log gets a `sensitive.read` row (who,
  which person, when).
- It never appears in the timeline summary, segments, staff exports, logs, error reports or AI
  prompts. Only the person's own GDPR export contains it.
- Forms that ask sensitive questions need a separate, explicit consent (`sensitive_processing`).

## The external partner role (Release 3)

A partner user is linked to a partner company. They see only their own holds, referrals and
counts. They never see customer names, emails or other personal data.

## The audit log

Every staff change writes an audit row with who, when, what, the old value and the new value.
Owners and technical_admins search it on `/admin/system/audit`. Examples: `credits.adjusted`,
`booking.cancel`, `refund.issued`, `person.merge`, `users.role_change`, `consent.change`,
`roles.update_permissions`. Audit rows are kept 5 years and cannot be changed.
