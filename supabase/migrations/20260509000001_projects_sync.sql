-- =============================================================================
-- v0.5.35 — End-to-end encrypted project sync.
-- =============================================================================
--
-- Goal: when a user is signed in (see migration 20260509000000), their
-- Typeset projects sync to Supabase so signing in on a fresh machine
-- restores the project list. Project payloads are encrypted on the
-- client (AES-256-GCM via WebCrypto) before upload — Postgres only ever
-- sees the ciphertext + per-row nonce.
--
-- Trade-off (documented to users in the Settings UI fine print): the
-- per-account sync key is stored in `auth.users.user_metadata.sync_key_b64`
-- so we can decrypt on a second device without a passphrase. This is
-- encrypted-in-transit and encrypted-at-rest, but Supabase
-- administrators have theoretical access to the key. v0.5.36 may add
-- an optional passphrase for true zero-knowledge sync — at which
-- point the schema below stays unchanged (key derivation moves to
-- the client, ciphertext column already opaque).
--
-- Schema:
--   id              client-generated uuid (matches local Project.id so
--                   sync uses the same identity end-to-end).
--   user_id         FK → auth.users(id), enforced via RLS.
--   ciphertext      bytea — AES-256-GCM ciphertext of the JSON-
--                   encoded Project payload.
--   nonce           bytea — 12-byte AES-GCM nonce, fresh per write.
--   modified_at     timestamptz — client-supplied last-modified time
--                   (mirrors Project.modifiedAt). Drives last-write-
--                   wins conflict resolution; the client does the
--                   compare, server is dumb storage.
--   server_updated_at  default now() — set by the server on every
--                   upsert. Used by the client's polling fallback to
--                   request "everything since X" on focus.
--   schema_version  int — forward-compat hook for the encrypted
--                   payload's inner shape (see projectStore.ts).
-- =============================================================================

create table if not exists public.projects (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  ciphertext bytea not null,
  nonce bytea not null check (octet_length(nonce) = 12),
  modified_at timestamptz not null,
  server_updated_at timestamptz not null default now(),
  schema_version int not null default 1
);

create index if not exists projects_user_idx
  on public.projects (user_id, modified_at desc);

create index if not exists projects_user_server_updated_idx
  on public.projects (user_id, server_updated_at desc);

-- Auto-bump server_updated_at on every UPDATE so realtime subscribers
-- get a meaningful version stamp regardless of whether the client
-- changed `modified_at` (which it always should, but let's not rely
-- on client correctness for server-side ordering).
create or replace function public._projects_touch_server_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.server_updated_at := now();
  return new;
end;
$$;

drop trigger if exists projects_touch_server_updated_at on public.projects;
create trigger projects_touch_server_updated_at
  before update on public.projects
  for each row execute function public._projects_touch_server_updated_at();

-- ---------------------------------------------------------------------------
-- Row-Level Security: a user can see and mutate exactly their own rows.
-- ---------------------------------------------------------------------------
alter table public.projects enable row level security;

drop policy if exists "projects: users see own" on public.projects;
create policy "projects: users see own"
  on public.projects for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- Realtime — `postgres_changes` for the user's own rows is what drives
-- the multi-device sync UX. Supabase exposes the full `replication`
-- publication automatically; we add `public.projects` to it explicitly
-- in case the user's project hasn't enabled "all tables" replication.
-- ---------------------------------------------------------------------------

-- alter publication is idempotent-ish (errors when already a member)
-- but DO blocks let us guard cleanly without forcing the user to
-- inspect output.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'projects'
  ) then
    execute 'alter publication supabase_realtime add table public.projects';
  end if;
end
$$;
