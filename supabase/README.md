# Typeset template registry — Supabase setup

Typeset's public template registry runs on Supabase. As of v0.5.8 the
project URL and publishable / anon key are **baked into the binary**,
so end-users don't configure anything — install Typeset and you're
on the shared registry on first launch:

- Every template you save with non-empty fields is **automatically
  shared** to the public registry — no separate publish click. (One
  button: Save.)
- Dropped PDFs match against community-published templates before
  falling back to Gemini detection, so other users dropping the same
  form get your field map for free.
- The **Browse community templates** panel in Settings is always
  available — search, install, upvote, all unconditionally.

The rest of this README is for **administrators** maintaining the
shared Supabase project. Run-of-the-mill users can ignore it.

## 1. Run the migration (once, per project)

1. Open the Supabase project dashboard.
2. Go to **SQL editor → New query**.
3. Paste the contents of
   [`supabase/migrations/20260508000000_init_template_submissions.sql`](./migrations/20260508000000_init_template_submissions.sql)
   into the editor and run it.

This creates:

- `template_submissions` — one row per published template.
- `template_submission_votes` — one (device, submission) upvote/downvote.
- `template_submission_flags` — one (device, submission) flag report.
- `match_template_submissions_by_fingerprint(...)` RPC for fast lookup.
- RLS policies that allow anonymous read + author-only update/delete
  keyed off the `x-device-id` header that the desktop client sends
  with every request.

### Verify

In the SQL editor, run:

```sql
select count(*) from template_submissions;
```

You should see `0` on a fresh project.

## 2. Wire the credentials into the binary

The production project URL and publishable key are hardcoded in
[`src/services/templateRegistry.ts`](../src/services/templateRegistry.ts).
Publishable keys are designed to be embedded — they only grant the
permissions allowed by the RLS policies above. To roll a fresh
project:

1. In **Project Settings → API** of the new Supabase project, copy
   the project URL and the **anon / public** key (either the
   `sb_publishable_*` format or the legacy JWT-shaped `eyJ...` anon
   key works).
2. Update `REGISTRY_URL` and `REGISTRY_KEY` in
   `src/services/templateRegistry.ts`.
3. Rebuild and ship.

For pointing local dev builds at a staging project without
rebuilding, set `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`
in `.env` — those override the baked-in defaults at compile time.

## 3. End-user experience

Users don't see any of the above. They:

1. Install Typeset.
2. Drop a PDF — Typeset checks the local cache, then the public
   registry, then falls back to Gemini detection (zero round-trip
   cost when a community template is a match).
3. After Gemini detects fields on a fresh form, click **Save template**
   in the review modal. A single toast confirms local save + registry
   publish. The first save creates the row; subsequent saves update
   it (RLS keys publish ownership to the device's anonymous id).
4. If the registry is unreachable (offline, RLS, etc.), the local
   save still succeeds and they see a non-blocking toast — work is
   never lost.

## Notes

- Anonymous identity uses a 128-bit UUID generated on first run and
  persisted in localStorage (see `src/services/deviceId.ts`). It's
  not a security boundary — anyone who copies it can claim publisher
  ownership of those rows. Acceptable trade-off for "no signup".
- Earlier versions (v0.5.0 — v0.5.7) stored the URL and publishable
  key in the OS keychain under `registry-supabase-url` and
  `registry-supabase-anon-key`. Those entries are now orphaned on
  user machines but cause no harm — the new code never reads them
  and there's no migration needed.
- The Gemini API key is still user-provided and stored in the OS
  keychain via the in-app Settings panel. It's unrelated to the
  registry credentials.
