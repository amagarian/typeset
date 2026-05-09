-- =============================================================================
-- Typeset public template registry — initial schema
-- =============================================================================
--
-- Goal: any Typeset user can drop a PDF and instantly get a verified field
-- map shared by another user who already wrapped that exact form. No login,
-- no email — just a stable per-device anonymous id used for rate-limiting,
-- attribution, and self-service deletion.
--
-- Trust model:
--   * `verified` is a soft signal driven by community upvotes, not a
--     manual review. The client orders results by `verification_score`
--     (computed from upvotes minus weighted flags).
--   * Anyone can publish, but rate-limits + flag thresholds keep it
--     usable. A submission that crosses the auto-hide threshold is
--     filtered out of search results until a human reviews it.
--   * No PII is ever stored: submissions contain field schemas (label,
--     position, fieldType, canonicalFieldId) only — not the user's
--     actual values nor the source PDF bytes.
--
-- Matching strategy:
--   * Client computes a `TemplateFingerprint` (page count, anchor terms,
--     checkbox terms, file-name hints, hash) and hits
--     `match_template_submissions_by_fingerprint(...)` with it. The
--     function does a coarse anchor-term overlap filter in Postgres
--     (cheap, gin index on text[]) and the client re-scores the top N
--     candidates with the full `scoreFingerprintMatch()` so semantics
--     stay identical to the local registry.
-- =============================================================================

-- Required for gen_random_uuid() and gin_trgm_ops fallback.
create extension if not exists pgcrypto;
create extension if not exists pg_trgm;

-- -----------------------------------------------------------------------------
-- template_submissions: one row per published template version.
--
-- We *don't* enforce uniqueness on fingerprint_hash because two different
-- communities may legitimately want different field maps for the same form
-- (e.g. one in English, one in Spanish; or one mapping CC fields, another
-- treating it as a billing form). Instead, the client groups by
-- fingerprint_hash and ranks by verification_score.
-- -----------------------------------------------------------------------------
create table if not exists public.template_submissions (
  id uuid primary key default gen_random_uuid(),

  -- Display
  name text not null check (char_length(name) between 1 and 120),
  description text check (char_length(description) <= 500),

  -- Matching
  fingerprint_hash text not null,
  fingerprint jsonb not null, -- the full TemplateFingerprint for client re-scoring
  page_count int not null check (page_count between 1 and 200),
  anchor_terms text[] not null default '{}'::text[],
  checkbox_terms text[] not null default '{}'::text[],
  file_name_hints text[] not null default '{}'::text[],
  canonical_field_ids text[] not null default '{}'::text[],

  -- The actual payload the client installs.
  fields jsonb not null,
  field_count int generated always as (jsonb_array_length(fields)) stored,

  -- Attribution / moderation
  publisher_device_id text not null check (char_length(publisher_device_id) between 8 and 128),
  upvotes int not null default 0,
  downvotes int not null default 0,
  flag_count int not null default 0,
  is_hidden boolean not null default false,
  hidden_reason text,

  -- Verification score: simple Wilson-style lower bound favouring
  -- submissions with at least a few upvotes. Recomputed via trigger.
  verification_score real not null default 0,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists template_submissions_fingerprint_hash_idx
  on public.template_submissions (fingerprint_hash)
  where is_hidden = false;

create index if not exists template_submissions_publisher_idx
  on public.template_submissions (publisher_device_id);

create index if not exists template_submissions_anchor_terms_gin_idx
  on public.template_submissions using gin (anchor_terms);

create index if not exists template_submissions_name_trgm_idx
  on public.template_submissions using gin (name gin_trgm_ops);

create index if not exists template_submissions_score_idx
  on public.template_submissions (verification_score desc, created_at desc)
  where is_hidden = false;

-- -----------------------------------------------------------------------------
-- template_submission_votes: one (device, submission) pair = at most one vote.
-- -----------------------------------------------------------------------------
create table if not exists public.template_submission_votes (
  submission_id uuid not null references public.template_submissions(id) on delete cascade,
  voter_device_id text not null check (char_length(voter_device_id) between 8 and 128),
  vote smallint not null check (vote in (-1, 1)),
  created_at timestamptz not null default now(),
  primary key (submission_id, voter_device_id)
);

create index if not exists template_submission_votes_submission_idx
  on public.template_submission_votes (submission_id);

-- -----------------------------------------------------------------------------
-- template_submission_flags: one row per (device, submission) flag report.
-- Multiple flags from different devices increment the parent submission's
-- flag_count.
-- -----------------------------------------------------------------------------
create table if not exists public.template_submission_flags (
  submission_id uuid not null references public.template_submissions(id) on delete cascade,
  reporter_device_id text not null check (char_length(reporter_device_id) between 8 and 128),
  reason text not null check (reason in ('spam', 'incorrect', 'pii', 'copyright', 'other')),
  detail text check (char_length(detail) <= 500),
  created_at timestamptz not null default now(),
  primary key (submission_id, reporter_device_id)
);

-- -----------------------------------------------------------------------------
-- Triggers to keep aggregates in sync.
-- -----------------------------------------------------------------------------

create or replace function public._recompute_submission_score(p_submission_id uuid)
returns void language plpgsql as $$
declare
  v_up int;
  v_down int;
  v_flags int;
  v_score real;
begin
  select coalesce(sum(case when vote = 1 then 1 else 0 end), 0),
         coalesce(sum(case when vote = -1 then 1 else 0 end), 0)
    into v_up, v_down
    from public.template_submission_votes
    where submission_id = p_submission_id;

  select count(*) into v_flags
    from public.template_submission_flags
    where submission_id = p_submission_id;

  -- Score: upvotes - 2*downvotes - 3*flags, normalised by total votes
  -- with a small constant prior to avoid division-by-zero. Hidden if
  -- flags >= 3 OR score <= -0.6.
  v_score := (v_up - 2 * v_down - 3 * v_flags)::real / greatest(1, v_up + v_down + v_flags + 3);

  update public.template_submissions
    set upvotes = v_up,
        downvotes = v_down,
        flag_count = v_flags,
        verification_score = v_score,
        is_hidden = case when v_flags >= 3 or v_score <= -0.6 then true else is_hidden end,
        updated_at = now()
    where id = p_submission_id;
end;
$$;

create or replace function public._template_submission_votes_after()
returns trigger language plpgsql as $$
begin
  perform public._recompute_submission_score(coalesce(new.submission_id, old.submission_id));
  return null;
end;
$$;

drop trigger if exists template_submission_votes_after on public.template_submission_votes;
create trigger template_submission_votes_after
  after insert or update or delete on public.template_submission_votes
  for each row execute function public._template_submission_votes_after();

create or replace function public._template_submission_flags_after()
returns trigger language plpgsql as $$
begin
  perform public._recompute_submission_score(coalesce(new.submission_id, old.submission_id));
  return null;
end;
$$;

drop trigger if exists template_submission_flags_after on public.template_submission_flags;
create trigger template_submission_flags_after
  after insert or update or delete on public.template_submission_flags
  for each row execute function public._template_submission_flags_after();

-- -----------------------------------------------------------------------------
-- match_template_submissions_by_fingerprint: server-side coarse filter.
--
-- Returns the top N candidates whose anchor_terms overlap the incoming
-- list, ordered by overlap count + verification_score. The client then
-- re-scores them with the full scoreFingerprintMatch() and picks the
-- winner — keeping the matching logic in one place.
-- -----------------------------------------------------------------------------

-- Postgres doesn't have an `&` array intersection operator by default;
-- emulate it with a small helper used only inside the matcher.
create or replace function public.array_intersect(anyarray, anyarray)
returns anyarray language sql immutable as $$
  select array(select unnest($1) intersect select unnest($2));
$$;

create or replace function public.match_template_submissions_by_fingerprint(
  p_fingerprint_hash text,
  p_page_count int,
  p_anchor_terms text[],
  p_limit int default 8
) returns setof public.template_submissions
language sql stable as $$
  -- Phase 1: exact fingerprint hash hit (rare but cheap).
  (select t.* from public.template_submissions t
    where t.is_hidden = false
      and t.fingerprint_hash = p_fingerprint_hash
    order by t.verification_score desc, t.created_at desc
    limit p_limit)
  union all
  -- Phase 2: anchor-term overlap, page-count tolerant.
  (select t.* from public.template_submissions t
    where t.is_hidden = false
      and t.fingerprint_hash <> p_fingerprint_hash
      and t.anchor_terms && p_anchor_terms
      and abs(t.page_count - p_page_count) <= 2
    order by cardinality(public.array_intersect(t.anchor_terms, p_anchor_terms)) desc nulls last,
             t.verification_score desc,
             t.created_at desc
    limit p_limit);
$$;

-- -----------------------------------------------------------------------------
-- Row-Level Security
-- -----------------------------------------------------------------------------
alter table public.template_submissions enable row level security;
alter table public.template_submission_votes enable row level security;
alter table public.template_submission_flags enable row level security;

-- Anyone (including the anon / publishable key) can read non-hidden rows.
drop policy if exists "template_submissions: public read" on public.template_submissions;
create policy "template_submissions: public read"
  on public.template_submissions for select
  using (is_hidden = false);

-- Anyone can publish. Rate-limiting is enforced at the application layer
-- and via flag-based auto-hide; RLS just enforces basic shape.
drop policy if exists "template_submissions: anyone can insert" on public.template_submissions;
create policy "template_submissions: anyone can insert"
  on public.template_submissions for insert
  with check (
    char_length(name) between 1 and 120
    and field_count > 0
    and char_length(publisher_device_id) between 8 and 128
  );

-- Publishers can update / delete their own rows by passing the same
-- device_id they originally published with (carried in the
-- `x-device-id` header by the Supabase client).
drop policy if exists "template_submissions: publisher can update" on public.template_submissions;
create policy "template_submissions: publisher can update"
  on public.template_submissions for update
  using (publisher_device_id = current_setting('request.jwt.claims', true)::jsonb->>'device_id'
         or publisher_device_id = current_setting('request.headers', true)::jsonb->>'x-device-id');

drop policy if exists "template_submissions: publisher can delete" on public.template_submissions;
create policy "template_submissions: publisher can delete"
  on public.template_submissions for delete
  using (publisher_device_id = current_setting('request.jwt.claims', true)::jsonb->>'device_id'
         or publisher_device_id = current_setting('request.headers', true)::jsonb->>'x-device-id');

-- Votes: anyone can vote / change their vote, but only on their own row.
drop policy if exists "template_submission_votes: read" on public.template_submission_votes;
create policy "template_submission_votes: read"
  on public.template_submission_votes for select using (true);

drop policy if exists "template_submission_votes: upsert own" on public.template_submission_votes;
create policy "template_submission_votes: upsert own"
  on public.template_submission_votes for insert
  with check (char_length(voter_device_id) between 8 and 128);

drop policy if exists "template_submission_votes: update own" on public.template_submission_votes;
create policy "template_submission_votes: update own"
  on public.template_submission_votes for update
  using (voter_device_id = current_setting('request.headers', true)::jsonb->>'x-device-id');

drop policy if exists "template_submission_votes: delete own" on public.template_submission_votes;
create policy "template_submission_votes: delete own"
  on public.template_submission_votes for delete
  using (voter_device_id = current_setting('request.headers', true)::jsonb->>'x-device-id');

-- Flags: anyone can flag once per submission.
drop policy if exists "template_submission_flags: insert" on public.template_submission_flags;
create policy "template_submission_flags: insert"
  on public.template_submission_flags for insert
  with check (char_length(reporter_device_id) between 8 and 128);

drop policy if exists "template_submission_flags: read own" on public.template_submission_flags;
create policy "template_submission_flags: read own"
  on public.template_submission_flags for select
  using (reporter_device_id = current_setting('request.headers', true)::jsonb->>'x-device-id');

-- The matcher RPC returns rows from a table that already has a public-read
-- RLS policy, so plain `stable` is fine.
grant execute on function public.match_template_submissions_by_fingerprint(text, int, text[], int) to anon, authenticated;
grant execute on function public.array_intersect(anyarray, anyarray) to anon, authenticated;
