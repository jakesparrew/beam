-- R4 (platform-P10, PL-23b, cross-module decision 46): the read-only role and schema of the
-- AI SQL runner `runAiReadOnlyQuery` (apps/web/modules/platform/ai-sql.ts).
--
-- This file creates only the role and the schema. It defines no view: every `ai.*` view
-- (including `ai.webinar_performance_daily`) is ops' `0101_ai_views_ops.sql`, applied after
-- this file, which also grants `select` on each view to `beam_ai_ro`. The role gets no grant
-- on any `public` table or view, so a statement that slips past the guards is refused by
-- Postgres. The runner switches to it with `set local role beam_ai_ro` inside a read-only
-- transaction on the normal pooled connection; the role cannot log in.
--
-- Idempotent: `applyCustomSql` and the custom migration may both run it.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'beam_ai_ro') then
    create role beam_ai_ro nologin noinherit nocreatedb nocreaterole;
  end if;
end
$$;

-- The application role must be a member to `set role` to it.
grant beam_ai_ro to current_user;

create schema if not exists ai;
grant usage on schema ai to beam_ai_ro;

-- The role reads only what ops grants it in `ai`; nothing it could create or run elsewhere.
revoke create on schema ai from beam_ai_ro;
revoke all on all tables in schema public from beam_ai_ro;
