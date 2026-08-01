-- pz_draft — the review gate.
--
-- Jacob's framing was "these will be sent to people." Everything upstream of
-- this table decides WHAT to say; this table decides whether it goes out at all.
--
-- The gate is only a gate if it cannot be walked around, so the design point is
-- the status machine, not the storage:
--
--     pending_review ──approve──> approved ──sent──> sent
--            │
--            └──reject──> rejected      (terminal)
--
-- The sender may only fetch `approved`. There is no query that hands it a
-- pending row, so "forgot to review" fails closed as an empty result rather
-- than as an unreviewed email arriving in someone's inbox.
--
-- This holds a person's address and the message written about them, so it
-- carries retention on the same terms as pz_log: an explicit column, defaulted,
-- and a purge function that honours it.

create table if not exists public.pz_draft (
  id                uuid        primary key default gen_random_uuid(),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  -- Retention is explicit. A draft nobody ever reviewed is still a record of a
  -- real person, and it should not live forever because a queue went quiet.
  retain_until      timestamptz not null default (now() + interval '90 days'),

  api_key_hash      text,

  -- ---- who it is for -------------------------------------------------------
  recipient_email   text        not null,
  recipient_name    text,
  company_name      text,

  -- ---- what was decided ----------------------------------------------------
  message_type      text        not null,
  icp               text        not null,
  icp_use_cases     jsonb       not null default '[]'::jsonb,
  body_source       text,
  use_case_type     text,
  -- 3/3 or 2/3. A non-unanimous vote is the cheapest thing to route to a human,
  -- so it is a column rather than something buried in a JSON blob.
  agreement         text,

  -- ---- the message itself --------------------------------------------------
  body              text        not null,
  -- Set only when a reviewer changed the copy. Keeping both means "what did the
  -- machine actually write" survives the edit, which is the whole point of
  -- measuring the machine.
  edited_body       text,

  -- ---- the decision --------------------------------------------------------
  status            text        not null default 'pending_review'
                    check (status in ('pending_review', 'approved', 'rejected', 'sent')),
  reviewed_by       text,
  reviewed_at       timestamptz,
  review_note       text,
  sent_at           timestamptz,

  -- ---- provenance ----------------------------------------------------------
  -- Every operative version, so a draft reviewed today can still be explained
  -- after the registries have moved on.
  versions          jsonb       not null default '{}'::jsonb
);

comment on table  public.pz_draft is 'Review gate for outbound copy. A sender may only read status=approved; pending rows are unreachable to it by design.';
comment on column public.pz_draft.edited_body is 'Reviewer''s replacement copy. body always keeps what the machine wrote, so edit rate stays measurable.';
comment on column public.pz_draft.agreement is 'Classifier vote split (e.g. 2/3). Non-unanimous is the cheapest signal to gate human review on.';
comment on column public.pz_draft.retain_until is 'Hard retention boundary, honoured by pz_draft_purge_expired().';

-- The review queue, newest first.
create index if not exists pz_draft_status_idx    on public.pz_draft (status, created_at desc);
-- "have we already drafted for this person recently" — the cooldown check.
create index if not exists pz_draft_recipient_idx on public.pz_draft (recipient_email, created_at desc);
create index if not exists pz_draft_retain_idx    on public.pz_draft (retain_until);

-- Same posture as pz_log: RLS on with no policies denies anon and authenticated
-- outright. The publishable key ships to the browser and must never be able to
-- read outbound copy about a named person.
alter table public.pz_draft enable row level security;
revoke all on public.pz_draft from anon, authenticated;

create or replace function public.pz_draft_touch()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists pz_draft_touch_trg on public.pz_draft;
create trigger pz_draft_touch_trg
  before update on public.pz_draft
  for each row execute function public.pz_draft_touch();

create or replace function public.pz_draft_purge_expired()
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  removed bigint;
begin
  delete from public.pz_draft where retain_until < now();
  get diagnostics removed = row_count;
  return removed;
end;
$$;

comment on function public.pz_draft_purge_expired is 'Deletes drafts past retain_until. Retention is a promise, not a preference.';
