-- pz_cache — per-person enrichment cache for the Personalization API.
--
-- Prefixed pz_ because this lives in an EXISTING Supabase project alongside
-- unrelated tables (the free-tier project cap is real). Nothing here is
-- namespaced by schema, so the prefix is the namespace.
--
-- Why one row per (key, source) instead of one row per person:
-- the two halves of an enrichment expire on different clocks. Funding facts
-- change slowly (30 days), recent LinkedIn posts do not (3 days). Splitting the
-- rows lets the Exa half go stale and refresh while the Fundable half is still
-- a hit, which is the whole point of the split TTL.

create table if not exists public.pz_cache (
  id            bigserial primary key,

  -- Normalised "<email_domain>|<linkedin_url>" — either side may be empty.
  -- Normalisation (lowercase, strip www., strip trailing slash) happens in the
  -- client so the key is stable regardless of how the caller formatted input.
  cache_key     text        not null,
  source        text        not null check (source in ('fundable', 'exa')),

  payload       jsonb       not null,

  fetched_at    timestamptz not null default now(),
  expires_at    timestamptz not null,

  -- Cheap observability: how often a cached row actually saved a call.
  hit_count     integer     not null default 0,
  last_hit_at   timestamptz,

  constraint pz_cache_key_source_uniq unique (cache_key, source)
);

comment on table  public.pz_cache        is 'Personalization API: per-person enrichment cache. Split TTL by source (fundable 30d, exa 3d).';
comment on column public.pz_cache.cache_key is 'Normalised "<email_domain>|<linkedin_url>". Lowercased, www. stripped, no trailing slash.';
comment on column public.pz_cache.expires_at is 'Set by the writer, not a trigger, so the TTL policy stays in application code where it is visible.';

-- The only read pattern is "is there a live row for this key and source".
create index if not exists pz_cache_lookup_idx
  on public.pz_cache (cache_key, source, expires_at desc);

-- Supports the purge sweep.
create index if not exists pz_cache_expires_idx
  on public.pz_cache (expires_at);

-- ---------------------------------------------------------------------------
-- Access control
-- ---------------------------------------------------------------------------
-- RLS on with NO policies = deny all for anon and authenticated. The API talks
-- to this table with the secret (service) key, which bypasses RLS. The
-- publishable key must never be able to read enrichment payloads, because they
-- contain data about real people.

alter table public.pz_cache enable row level security;

revoke all on public.pz_cache from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Purge
-- ---------------------------------------------------------------------------
-- Called by cron or by hand. Expired rows are worthless, so this is an
-- unconditional delete rather than a soft delete.

create or replace function public.pz_cache_purge_expired()
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  removed bigint;
begin
  delete from public.pz_cache where expires_at < now();
  get diagnostics removed = row_count;
  return removed;
end;
$$;

comment on function public.pz_cache_purge_expired is 'Deletes expired cache rows. Returns the count removed. Safe to run repeatedly.';
