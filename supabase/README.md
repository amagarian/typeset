# Typeset template registry — Supabase setup

Typeset's optional public template registry runs on Supabase. The whole
feature is optional; the desktop app works fully without it. With it
configured:

- Every template you save is **automatically shared** to the public
  registry — no separate publish click. (One button: Save.)
- Dropped PDFs match against community-published templates before
  falling back to Gemini detection, so other users dropping the same
  form get your field map for free.

Setup takes ~5 minutes on a fresh project.

## 1. Run the migration

1. Open your Supabase project dashboard.
2. Go to **SQL editor → New query**.
3. Paste the contents of
   [`supabase/migrations/20260508000000_init_template_submissions.sql`](./migrations/20260508000000_init_template_submissions.sql)
   into the editor and run it.

This creates:

- `template_submissions` — one row per published template.
- `template_submission_votes` — one (device, submission) upvote/downvote.
- `template_submission_flags` — one (device, submission) flag report.
- `match_template_submissions_by_fingerprint(...)` RPC for fast lookup.
- RLS policies that allow anonymous read + author-only update/delete.

### Verify

In the SQL editor, run:

```sql
select count(*) from template_submissions;
```

You should see `0` on a fresh project.

## 2. Find your project URL + key

In the Supabase dashboard:

- **Project Settings → API**
  - **Project URL** → copy this. Looks like `https://abcdefgh.supabase.co`.
  - **Project API keys → anon / public** → copy this. The newer
    `sb_publishable_*` format and the legacy JWT-shaped `eyJ...` anon
    key both work — Typeset accepts either.

The publishable / anon key is safe to ship in a desktop binary: it
only grants the permissions defined by the RLS policies above.

## 3. Paste them into Typeset

1. Open Typeset → click the gear icon → **Settings**.
2. Scroll to **Template registry (Supabase)**.
3. Paste the project URL into the first field.
4. Paste the anon / publishable key into the second field.
5. Click **Save credentials** → **Test connection**.
6. Expect: `OK — 0 templates in registry.`

Done. From now on:

- Drop a PDF → Typeset checks your local cache, then the public
  registry, then falls back to Gemini detection (zero round-trip
  cost when a community template is a match).
- After Gemini detects fields on a fresh form, click **Save template**
  in the review modal. You'll get a single toast confirming local save
  + registry publish in one step. The first save creates the row;
  subsequent saves update it (RLS keys publish ownership to your
  device). If the local fields haven't changed, the registry call
  is a no-op.
- If the registry is unreachable (offline, RLS, etc.), the local save
  still succeeds and you'll see a non-blocking toast — your work is
  never lost.

## Resetting

- Replace credentials any time in Settings — they're stored in the OS
  keychain and a save+test cycle hot-swaps the client.
- Click **Clear** in Settings to remove credentials. The app reverts
  to local-only mode immediately; existing local templates are
  untouched.
