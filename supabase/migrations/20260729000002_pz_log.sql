-- pz_log — request/response log for the Personalization API.
--
-- This table holds OUTBOUND CONTENT ABOUT REAL PEOPLE: their name, employer,
-- funding events, and the message we generated about them. That is why
-- retention is an explicit column and not a vague intention. Every row carries
-- its own retain_until, defaulting to 90 days, and pz_log_purge_expired()
-- honours it.
--
-- It exists for three jobs:
--   1. Auditing a bad message after the fact ("where did that claim come from").
--   2. Tuning: angle + confidence + status on every row means reply-rate-by-angle
--      is a join away once HubSpot carries the outcome.
--   3. Rate limiting attribution per API key.

create table if not exists public.pz_log (
  id                uuid        primary key default gen_random_uuid(),
  created_at        timestamptz not null default now(),

  -- Retention is explicit. See the header comment.
  retain_until      timestamptz not null default (now() + interval '90 days'),

  -- ---- request -------------------------------------------------------------
  -- Which key made the call. Hashed, never the key itself.
  api_key_hash      text,

  -- Quoted: TRIGGER is non-reserved in Postgres and works unquoted, but quoting
  -- costs nothing and removes any doubt. Lowercase-quoted == unquoted, so
  -- PostgREST and every client still see plain `trigger`.
  "trigger"         text        not null check ("trigger" in ('sign-up', 'website-visitor', 'cold', 'post-raise')),
  channel           text        not null check (channel in ('email', 'linkedin')),

  person_email      text,
  person_linkedin   text,
  person_name       text,

  sender_context    text,
  max_facts         smallint,
  template_provided boolean     not null default false,

  -- ---- resolution ----------------------------------------------------------
  company_id        text,
  company_name      text,
  company_domain    text,
  person_id         text,

  -- ---- output --------------------------------------------------------------
  status            text        not null check (status in ('personalized', 'template_only', 'no_match')),
  confidence        numeric(3,2) check (confidence >= 0 and confidence <= 1),
  angle             text,
  subject           text,
  body              text,

  -- Full evidence array as returned, so a claim can be traced years later.
  evidence          jsonb       not null default '[]'::jsonb,
  warnings          jsonb       not null default '[]'::jsonb,

  -- Set when VERIFY caught something. Non-null here means the claim checker
  -- earned its keep on this row.
  verify_issues     jsonb,
  verify_retried    boolean     not null default false,

  -- ---- usage ---------------------------------------------------------------
  fundable_credits  integer,
  exa_cost_usd      numeric(10,6),
  llm_tokens        integer,
  latency_ms        integer,

  -- ---- voice ---------------------------------------------------------------
  -- Recorded per row: copy written under the placeholder voice must be
  -- distinguishable from copy written after Jacob's real emails land.
  voice_id          text,
  voice_provenance  text
);

comment on table  public.pz_log is 'Personalization API request log. Contains outbound content about real people; retention enforced via retain_until (default 90d).';
comment on column public.pz_log.retain_until is 'Hard retention boundary. pz_log_purge_expired() deletes rows past this. Extend deliberately, never by default.';
comment on column public.pz_log.api_key_hash is 'SHA-256 of the presented bearer key. Never store the key itself.';
comment on column public.pz_log.voice_provenance is 'placeholder | real_examples — which voice profile generation this copy came from.';

-- Reporting: status/angle breakdowns over a window.
create index if not exists pz_log_created_idx      on public.pz_log (created_at desc);
create index if not exists pz_log_angle_status_idx on public.pz_log (angle, status);
create index if not exists pz_log_company_idx      on public.pz_log (company_domain);
-- Rate limiting: count rows for this key in the last hour.
create index if not exists pz_log_key_window_idx   on public.pz_log (api_key_hash, created_at desc);
-- Purge sweep.
create index if not exists pz_log_retain_idx       on public.pz_log (retain_until);

-- ---------------------------------------------------------------------------
-- Access control
-- ---------------------------------------------------------------------------
-- Same posture as pz_cache, and it matters more here. RLS on with no policies
-- denies anon and authenticated outright; only the secret key (which bypasses
-- RLS) can read or write. The publishable key ships to the browser in the demo
-- UI and must never be able to read generated outbound copy.

alter table public.pz_log enable row level security;

revoke all on public.pz_log from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Purge
-- ---------------------------------------------------------------------------

create or replace function public.pz_log_purge_expired()
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  removed bigint;
begin
  delete from public.pz_log where retain_until < now();
  get diagnostics removed = row_count;
  return removed;
end;
$$;

comment on function public.pz_log_purge_expired is 'Deletes log rows past retain_until. Returns the count removed. Run on a schedule; retention is a promise, not a preference.';
