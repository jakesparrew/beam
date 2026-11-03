# Requests carried between packages

Requests a package reported for another module (runbook 5.2). The orchestrator adds each open
request to the launch instructions of the first later package of the named module, then moves it
to "Served" with the package id.

## Open

| From | For | Request |
| --- | --- | --- |
| platform-P2 | platform-P7 | Call `seedDefaults(db, { permissions: PERMISSIONS })` in `apps/web/scripts/seed-demo.ts`, so role grants follow the permissions registry. |
| platform-P2 | crm, booking, commerce, finance, forms, email, automation, site (first package of each) | When you create the tables referenced by the Wave 0 contract-table stubs, add the foreign keys noted in the stub comments (companies, session_templates, ticket_types, promotions, checkouts, form_versions, email_template_versions, campaigns, automation_groups, automation_versions, page_versions). |
| platform-P3 | crm (inbox AI drafts, R3) | `callClaude` feature key is `ai.draft_reply`, not `inbox_draft`. Its fields `thread_messages` and `knowledge_articles` are not in `AI_ALLOWED_FIELDS`: the crm package that builds AI reply drafts decides and documents which fields are sent, and asks platform for an `AI_ALLOWED_FIELDS` addition if needed. |
| platform-P3 | email (AI campaign drafts, R4) | `callClaude` feature key is `ai.draft_email`, not `email.draft_email`. |

## Served

| From | For | Request | Served by |
| --- | --- | --- | --- |
| platform-P3 | platform-P5 | The job runner treats `isPermanentFailure()` from `@beam/integrations/_shared` as dead at once. | platform-P5 (in its launch instructions) |
