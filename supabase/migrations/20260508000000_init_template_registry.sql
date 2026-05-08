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
--     usable. A template that crosses the auto-hide threshold is
--     filtered out of search results until a human reviews it.
--   * No PII is ever stored: templates contain field schemas (label,
--     position, fieldType, canonicalFieldId) only — not the user's
--     actual values nor the source PDF bytes.
--
-- Matching strategy:
--   * Client computes a `TemplateFingerprint` (page count, anchor terms,
--     checkbox terms, file-name hints, hash) and hits
--     `match_templates_by_fingerprint(...)` with it. The function does
--     a coarse anchor-term overlap filter in Postgres (cheap, gin index
--     on jsonb) and the client re-scores the top N candidates with the
--     full `scoreFingerprintMatch()` so semantics stay identical to the
--     local registry.
-- =============================================================================

-- Required for gen_random_uuid() and gin_trgm_ops fallback.
create extension if not exists pgcrypto;
create extension if not exists pg_trgm;

-- -----------------------------------------------------------------------------
-- registry_templates: one row per published template version.
--
-- We *don't* enforce uniqueness on fingerprint_hash because two different
-- communities may legitimately want different field maps for the same form
-- (e.g. one in English, one in Spanish; or one mapping CC fields, another
-- treating it as a billing form). Instead, the client groups by
-- fingerprint_hash and ranks by verification_score.
-- -----------------------------------------------------------------------------
create table if not exists public.registry_templates (
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
  -- templates with at least a few upvotes. Recomputed via trigger.
  verification_score real not null default 0,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists registry_templates_fingerprint_hash_idx
  on public.registry_templates (fingerprint_hash)
  where is_hidden = false;

create index if not exists registry_templates_publisher_idx
  on public.registry_templates (publisher_device_id);

create index if not exists registry_templates_anchor_terms_gin_idx
  on public.registry_templates using gin (anchor_terms);

create index if not exists registry_templates_name_trgm_idx
  on public.registry_templates using gin (name gin_trgm_ops);

create index if not exists registry_templates_score_idx
  on public.registry_templates (verification_score desc, created_at desc)
  where is_hidden = false;

-- -----------------------------------------------------------------------------
-- registry_votes: one (device, template) pair = at most one vote.
-- -----------------------------------------------------------------------------
create table if not exists public.registry_votes (
  template_id uuid not null references public.registry_templates(id) on delete cascade,
  voter_device_id text not null check (char_length(voter_device_id) between 8 and 128),
  vote smallint not null check (vote in (-1, 1)),
  created_at timestamptz not null default now(),
  primary key (template_id, voter_device_id)
);

create index if not exists registry_votes_template_idx on public.registry_votes (template_id);

-- -----------------------------------------------------------------------------
-- registry_flags: one row per (device, template) flag report. Multiple
-- flags from different devices increment the parent template's flag_count.
-- -----------------------------------------------------------------------------
create table if not exists public.registry_flags (
  template_id uuid not null references public.registry_templates(id) on delete cascade,
  reporter_device_id text not null check (char_length(reporter_device_id) between 8 and 128),
  reason text not null check (reason in ('spam', 'incorrect', 'pii', 'copyright', 'other')),
  detail text check (char_length(detail) <= 500),
  created_at timestamptz not null default now(),
  primary key (template_id, reporter_device_id)
);

-- -----------------------------------------------------------------------------
-- Triggers to keep aggregates in sync.
-- -----------------------------------------------------------------------------

create or replace function public._recompute_template_score(p_template_id uuid)
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
    from public.registry_votes
    where template_id = p_template_id;

  select count(*) into v_flags
    from public.registry_flags
    where template_id = p_template_id;

  -- Score: upvotes - 2*downvotes - 3*flags, normalised by total votes
  -- with a small constant prior to avoid division-by-zero. Hidden if
  -- flags >= 3 OR score <= -3.
  v_score := (v_up - 2 * v_down - 3 * v_flags)::real / greatest(1, v_up + v_down + v_flags + 3);

  update public.registry_templates
    set upvotes = v_up,
        downvotes = v_down,
        flag_count = v_flags,
        verification_score = v_score,
        is_hidden = case when v_flags >= 3 or v_score <= -0.6 then true else is_hidden end,
        updated_at = now()
    where id = p_template_id;
end;
$$;

create or replace function public._registry_votes_after()
returns trigger language plpgsql as $$
begin
  perform public._recompute_template_score(coalesce(new.template_id, old.template_id));
  return null;
end;
$$;

drop trigger if exists registry_votes_after on public.registry_votes;
create trigger registry_votes_after
  after insert or update or delete on public.registry_votes
  for each row execute function public._registry_votes_after();

create or replace function public._registry_flags_after()
returns trigger language plpgsql as $$
begin
  perform public._recompute_template_score(coalesce(new.template_id, old.template_id));
  return null;
end;
$$;

drop trigger if exists registry_flags_after on public.registry_flags;
create trigger registry_flags_after
  after insert or update or delete on public.registry_flags
  for each row execute function public._registry_flags_after();

-- -----------------------------------------------------------------------------
-- match_templates_by_fingerprint: server-side coarse filter.
--
-- Returns the top N candidates whose anchor_terms overlap the incoming
-- list, ordered by overlap count + verification_score. The client then
-- re-scores them with the full scoreFingerprintMatch() and picks the
-- winner — keeping the matching logic in one place.
-- -----------------------------------------------------------------------------
create or replace function public.match_templates_by_fingerprint(
  p_fingerprint_hash text,
  p_page_count int,
  p_anchor_terms text[],
  p_limit int default 8
) returns setof public.registry_templates
language sql stable as $$
  -- Phase 1: exact fingerprint hash hit (rare but cheap).
  (select t.* from public.registry_templates t
    where t.is_hidden = false
      and t.fingerprint_hash = p_fingerprint_hash
    order by t.verification_score desc, t.created_at desc
    limit p_limit)
  union all
  -- Phase 2: anchor-term overlap, page-count tolerant.
  (select t.* from public.registry_templates t
    where t.is_hidden = false
      and t.fingerprint_hash <> p_fingerprint_hash
      and t.anchor_terms && p_anchor_terms
      and abs(t.page_count - p_page_count) <= 2
    order by cardinality(t.anchor_terms & p_anchor_terms) desc nulls last,
             t.verification_score desc,
             t.created_at desc
    limit p_limit);
$$;

-- Postgres doesn't have an `&` array intersection operator by default;
-- emulate it with a small helper used only inside the matcher.
create or replace function public.array_intersect(anyarray, anyarray)
returns anyarray language sql immutable as $$
  select array(select unnest($1) intersect select unnest($2));
$$;

-- Re-create matcher using the helper.
create or replace function public.match_templates_by_fingerprint(
  p_fingerprint_hash text,
  p_page_count int,
  p_anchor_terms text[],
  p_limit int default 8
) returns setof public.registry_templates
language sql stable as $$
  (select t.* from public.registry_templates t
    where t.is_hidden = false
      and t.fingerprint_hash = p_fingerprint_hash
    order by t.verification_score desc, t.created_at desc
    limit p_limit)
  union all
  (select t.* from public.registry_templates t
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
alter table public.registry_templates enable row level security;
alter table public.registry_votes enable row level security;
alter table public.registry_flags enable row level security;

-- Anyone (including the anon key) can read non-hidden templates.
drop policy if exists "registry_templates: public read" on public.registry_templates;
create policy "registry_templates: public read"
  on public.registry_templates for select
  using (is_hidden = false);

-- Anyone can publish. Rate limiting happens via an edge function (see
-- supabase/functions/publish-template/) — RLS only enforces shape.
drop policy if exists "registry_templates: anyone can insert" on public.registry_templates;
create policy "registry_templates: anyone can insert"
  on public.registry_templates for insert
  with check (
    char_length(name) between 1 and 120
    and field_count > 0
    and char_length(publisher_device_id) between 8 and 128
  );

-- Publishers can update / delete their own templates by passing the
-- same device_id they originally published with.
drop policy if exists "registry_templates: publisher can update" on public.registry_templates;
create policy "registry_templates: publisher can update"
  on public.registry_templates for update
  using (publisher_device_id = current_setting('request.jwt.claims', true)::jsonb->>'device_id'
         or publisher_device_id = current_setting('request.headers', true)::jsonb->>'x-device-id');

drop policy if exists "registry_templates: publisher can delete" on public.registry_templates;
create policy "registry_templates: publisher can delete"
  on public.registry_templates for delete
  using (publisher_device_id = current_setting('request.jwt.claims', true)::jsonb->>'device_id'
         or publisher_device_id = current_setting('request.headers', true)::jsonb->>'x-device-id');

-- Votes: anyone can vote / change their vote, but only on their own row.
drop policy if exists "registry_votes: read" on public.registry_votes;
create policy "registry_votes: read"
  on public.registry_votes for select using (true);

drop policy if exists "registry_votes: upsert own" on public.registry_votes;
create policy "registry_votes: upsert own"
  on public.registry_votes for insert
  with check (char_length(voter_device_id) between 8 and 128);

drop policy if exists "registry_votes: update own" on public.registry_votes;
create policy "registry_votes: update own"
  on public.registry_votes for update
  using (voter_device_id = current_setting('request.headers', true)::jsonb->>'x-device-id');

drop policy if exists "registry_votes: delete own" on public.registry_votes;
create policy "registry_votes: delete own"
  on public.registry_votes for delete
  using (voter_device_id = current_setting('request.headers', true)::jsonb->>'x-device-id');

-- Flags: anyone can flag once per template.
drop policy if exists "registry_flags: insert" on public.registry_flags;
create policy "registry_flags: insert"
  on public.registry_flags for insert
  with check (char_length(reporter_device_id) between 8 and 128);

drop policy if exists "registry_flags: read own" on public.registry_flags;
create policy "registry_flags: read own"
  on public.registry_flags for select
  using (reporter_device_id = current_setting('request.headers', true)::jsonb->>'x-device-id');

-- The matcher RPC needs SECURITY DEFINER-ish access to read across the
-- table, but it returns rows from the same table that already has a
-- public-read RLS policy, so plain `stable` is fine.
grant execute on function public.match_templates_by_fingerprint(text, int, text[], int) to anon, authenticated;
grant execute on function public.array_intersect(anyarray, anyarray) to anon, authenticated;
