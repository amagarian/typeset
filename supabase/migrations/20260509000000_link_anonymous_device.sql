-- =============================================================================
-- v0.5.35 — Anonymous device → auth account migration.
-- =============================================================================
--
-- Until v0.5.34, every Typeset install carried a localStorage `device_id`
-- (see `src/services/deviceId.ts`). Community template submissions were
-- attributed to that id via `template_submissions.publisher_device_id`,
-- and contribution stats counted the rows where that column matched.
--
-- v0.5.35 introduces magic-link auth (Supabase email OTP). When a user
-- signs in for the first time on a device that was previously
-- contributing anonymously, we want their existing submissions to
-- carry over to the new account so the contribution badge doesn't
-- reset to zero. This migration:
--
--   1. Adds a nullable `user_id` column on `template_submissions`,
--      referencing `auth.users(id)`, with `ON DELETE SET NULL` so a
--      user who deletes their account doesn't take their published
--      community templates with them. The id stays null and the row
--      reverts to "anonymous publisher with this device id" — the
--      community keeps the field map.
--   2. Adds `link_anonymous_device(p_device_id text)` RPC that
--      claims all rows whose `publisher_device_id` matches the
--      caller's argument *and* whose `user_id` is currently null.
--      Idempotent: re-running on the same device after the first
--      sign-in does nothing.
--   3. Permits authenticated users to update their own rows by
--      `user_id` (extending the existing device-id-based update
--      policy). Anonymous device updates keep working — RLS is
--      additive across policies.
--
-- We deliberately don't trigger this migration server-side from
-- `auth.users` insert, because the device id only exists on the
-- client. The renderer calls the RPC explicitly via
-- `linkAnonymousDeviceToAccount()` in `services/authClient.ts` after
-- a fresh sign-in.
-- =============================================================================

-- 1. user_id column ----------------------------------------------------------

alter table public.template_submissions
  add column if not exists user_id uuid references auth.users(id) on delete set null;

create index if not exists template_submissions_user_id_idx
  on public.template_submissions (user_id)
  where user_id is not null;

-- 2. link_anonymous_device RPC -----------------------------------------------

create or replace function public.link_anonymous_device(p_device_id text)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid;
  v_count int;
begin
  v_uid := auth.uid();
  -- Anonymous calls (no Authorization header) get auth.uid() = null.
  -- Refuse rather than silently no-op so callers know to retry once
  -- their session is set.
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;

  -- Basic sanity on the device id; must match the same length /
  -- character constraints used elsewhere on `publisher_device_id`.
  if p_device_id is null or char_length(p_device_id) not between 8 and 128 then
    raise exception 'Invalid device id' using errcode = '22023';
  end if;

  with claimed as (
    update public.template_submissions
       set user_id = v_uid
     where publisher_device_id = p_device_id
       and user_id is null
    returning 1
  )
  select count(*) into v_count from claimed;
  return v_count;
end;
$$;

revoke all on function public.link_anonymous_device(text) from public;
grant execute on function public.link_anonymous_device(text) to authenticated;

-- 3. RLS — let authenticated users update / delete by user_id ---------------

drop policy if exists "template_submissions: user can update" on public.template_submissions;
create policy "template_submissions: user can update"
  on public.template_submissions for update
  using (auth.uid() is not null and user_id = auth.uid());

drop policy if exists "template_submissions: user can delete" on public.template_submissions;
create policy "template_submissions: user can delete"
  on public.template_submissions for delete
  using (auth.uid() is not null and user_id = auth.uid());

-- 4. Insert path: stamp user_id from the JWT when present.
--
-- We do this at the policy level rather than via a trigger so the
-- check stays additive: anonymous inserts (no JWT) keep working
-- because the existing "anyone can insert" policy is still in
-- effect. Authenticated inserts get a server-side guarantee that
-- they can't claim someone else's user_id (the WITH CHECK clause
-- requires either a null user_id — anonymous publish — or one
-- matching the JWT).
-- ---------------------------------------------------------------------------

drop policy if exists "template_submissions: anyone can insert" on public.template_submissions;
create policy "template_submissions: anyone can insert"
  on public.template_submissions for insert
  with check (
    char_length(name) between 1 and 120
    and field_count > 0
    and char_length(publisher_device_id) between 8 and 128
    and (user_id is null or user_id = auth.uid())
  );
