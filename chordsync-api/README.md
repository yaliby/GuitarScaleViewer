# ChordSync API

The API is a Cloudflare Worker backed by Supabase. It reads administrator-verified song keys and accepts untrusted suggestions for later review.

## Local setup

1. Create a Supabase project or start the Supabase CLI locally.
2. Apply `supabase/migrations/20260914000000_create_song_key_tables.sql` with `supabase db push` (linked project) or `supabase migration up` (local project).
3. Copy `.dev.vars.example` to `.dev.vars` and fill in the local Supabase URL, service-role key, and an admin secret. `.dev.vars` is ignored by git.
4. Run `npm ci`, then `npm test -- --run` and `npm run dev`.

The worker uses the service-role key server-side. Do not expose `.dev.vars`, commit real secrets, or put the service-role key in the frontend.

## HTTP contract

The test suite uses the Cloudflare Vitest 4 plugin. The narrow package overrides keep its Wrangler/Miniflare dependencies on the patched versions verified with this suite; update them together with the pool package. The current lockfile passes all 12 worker tests and reports zero known npm audit vulnerabilities. No deployment is performed by these tests.

- `GET /lookup-song?title=...&artist=...` returns `{ "found": boolean, "song": object | null }`. Only verified rows are returned.
- `POST /submit-suggestion` accepts JSON `{ "title", "artist", "key", "mode", "user"? }` and returns `{ "success": true }`. Keys are `A` through `G` with one optional `#` or `b`; modes are `major` or `minor`.
- `GET /admin/pending` requires `x-admin-secret` and returns pending suggestion rows.

Validation failures return status 400 and `{ "error": string }`. Database failures return status 500 with the same error shape. Browser CORS is restricted to localhost/127.0.0.1 development origins and the Tauri localhost origins; requests without an `Origin` header remain available to trusted non-browser clients.
