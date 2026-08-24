-- The three CHECK constraints below were written for the legacy pipeline's
-- vocabulary (channel 'email'/'linkedin', status 'personalized'/..., four
-- hyphenated triggers). /api/v1/personalize writes channel 'v1/personalize',
-- status 'ok', and underscore message types — so EVERY row it wrote since the
-- Neon migration was rejected, and record()'s never-fail-a-send catch made the
-- rejection silent. Telemetry enums cost more than they protect: the log's job
-- is to record what happened, not to veto it.
alter table public.pz_log drop constraint if exists pz_log_trigger_check;
alter table public.pz_log drop constraint if exists pz_log_channel_check;
alter table public.pz_log drop constraint if exists pz_log_status_check;
