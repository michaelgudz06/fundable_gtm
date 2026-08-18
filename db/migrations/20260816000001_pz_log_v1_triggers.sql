-- pz_log: accept the v1 route's trigger vocabulary.
--
-- Two live systems write this table and they name things differently:
--
--   /api/personalize      (legacy pipeline) — 'sign-up', 'website-visitor', …
--   /api/v1/personalize   (registry-driven) — MESSAGE_TYPES, which are the
--                          underscored 'website_visitor', 'signup_paid', …
--
-- Only the first vocabulary was ever allowed, so EVERY v1 log insert has been
-- rejected since the route shipped — silently, because storage.log() swallows
-- its own errors by design and v1's success body is exactly three keys
-- (API-003), leaving `lastError` nowhere to surface. The rejection was found
-- during the Neon migration by counting rows after a known-good request.
--
-- The other two violations on that insert were the route's fault, not the
-- schema's, and were fixed there instead of by widening a column:
--   channel was 'v1/personalize' — a route name in a channel column. v1 only
--     ever produces an email body, so it now writes 'email'.
--   status was 'ok', which is not a member of any vocabulary. It now writes
--     'personalized' or 'template_only', so v1 rows are comparable with legacy
--     rows — which is the whole reason this column exists.
--
-- The two vocabularies stay distinguishable by shape: hyphens are the legacy
-- pipeline, underscores are v1.

alter table public.pz_log drop constraint if exists pz_log_trigger_check;

alter table public.pz_log add constraint pz_log_trigger_check check (
  "trigger" in (
    -- legacy pipeline (/api/personalize)
    'sign-up', 'website-visitor', 'cold', 'post-raise',
    -- v1 (/api/v1/personalize) — keep in step with MESSAGE_TYPES in lib/v2/registry.ts
    'website_visitor', 'signup_paid', 'signup_unpaid', 'cold_outbound', 'nurture'
  )
);
