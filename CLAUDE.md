# CLAUDE.md

Context for Claude Code working in this repo.

## What this is

Personal-use Next.js 15 (App Router) + TypeScript app. Connect Strava → set preferences → see 3-5 rule-based activity suggestions for the week. Also emits a paste-ready LLM prompt. No server-side LLM calls.

## Stack

- Next.js 15 App Router, React 19, TS
- Auth.js v5 (`next-auth@5.0.0-beta.25`) with Strava provider + `@auth/drizzle-adapter`
- Drizzle ORM + Postgres via `postgres-js` (Neon-compatible)
- Tailwind v3, mobile-first
- vitest for the suggestion engine + processed-activity pipeline

## Key paths

- `src/auth.config.ts` — edge-safe Auth.js slice: providers (Strava scope `read,activity:read_all`), callbacks, pages. No DB imports.
- `src/auth.ts` — Node-only assembly: spreads `authConfig`, attaches `DrizzleAdapter`, sets `session.strategy = "database"`. Exports `auth`, `handlers`, `signIn`, `signOut`.
- `src/db/schema.ts` — all tables (managed Auth.js tables + `preferences`, `activity_cache`, rate-state tables, `suggestion_outcomes`)
- `src/db/client.ts` — Drizzle + `postgres-js` client
- `src/lib/strava/client.ts` — fetch wrapper with auto-refresh, rate-limit headers, 429 backoff
- `src/lib/strava/sync.ts` — 90-day pull, 15-min staleness gate, upserts into `activity_cache`; exports `rowToRaw` helper for cached row → `RawActivity`
- `src/lib/suggestions/processed.ts` — `processActivities`: raw Strava → `ProcessedActivity` (GAP, weighted-percentile effort buckets)
- `src/lib/suggestions/state.ts` — `computeAthleteState`: 7d/28d load, ACWR, days-since-last-run, typical pace
- `src/lib/suggestions/rules.ts` — rule functions returning `RuleCandidate[]`, composed in `generateCandidates`
- `src/lib/suggestions/engine.ts` — `generateSuggestions` orchestrator: picks onboarding/returning/normal mode, dedupes, pads, renumbers
- `src/lib/suggestions/prefs-adapter.ts` — `adaptDbPrefs`: DB preferences row → engine `PreferencesInput`
- `src/lib/suggestions/{prompt,state-summary,types}.ts` — LLM prompt builder, dashboard one-line summary, shared types
- `src/app/dashboard/page.tsx` — server-renders feed, triggers sync if stale
- `src/components/AiPlanModal.tsx` — bottom-sheet modal that shows the LLM prompt + copy-to-clipboard
- `src/middleware.ts` — Edge-runtime cookie-presence gate for `/dashboard`, `/onboarding`, `/preferences`. Does NOT validate the session — just bounces if no Auth.js cookie is present.

## Auth & middleware (Edge-runtime gotchas)

This project uses the Auth.js v5 **split config** pattern. Respect it — getting it wrong breaks the build or quietly disables auth.

- **`auth.config.ts` must stay edge-safe.** Providers, callbacks, `pages`, cookie/CSRF options go here. Do NOT import `@/db/*`, `@/auth` (circular), the DrizzleAdapter, `postgres`, or any Node-only module from this file. Importing `@/env` is fine (it only reads `process.env`).
- **`auth.ts` is Node-only.** The DrizzleAdapter and `session: { strategy: "database" }` live here. Anything that needs the DB (adapter, custom DB-touching callbacks) goes here, not in `auth.config.ts`.
- **Middleware is intentionally NOT using `auth()`.** With database sessions, validating in middleware would require a DB round trip on every protected request, and the adapter isn't edge-safe anyway. `src/middleware.ts` only checks for the presence of the Auth.js session cookie (`authjs.session-token` / `__Secure-authjs.session-token`) and redirects to `/` if missing.
- **Invariant: every protected page and API route MUST call `await auth()` server-side and redirect/401 on missing session.** The middleware is a fast-path, not a security boundary — cookie presence ≠ valid session. If you add a new protected route, start it with:
  ```ts
  const session = await auth();
  if (!session?.user?.id) redirect("/"); // or NextResponse.json({error}, {status:401})
  ```
- **Do NOT import `@/auth`, `@/db/*`, or `drizzle-orm` from `src/middleware.ts`.** It runs on the Edge runtime; pulling in the adapter or DB client will fail the build (or bloat the edge bundle).
- **Cookie names are Auth.js v5 defaults.** If you ever set a custom `cookies.sessionToken.name` in `auth.config.ts`, update the `SESSION_COOKIES` list in `src/middleware.ts` to match.
- **Database session strategy means JWT patterns don't apply.** No `jwt` callback, no `req.auth` in middleware, no stashing data on a token. The `session` callback receives `{ session, user }` where `user` is the DB row — that's where `session.user.id` is populated.

## Conventions

- All Strava calls go through `src/lib/strava/client.ts` server-side. Never call Strava from the client.
- Suggestion engine is pure: `generateSuggestions(processed, prefs, now) => EngineResult` (`{ state, suggestions, alternatives, mode }`). Inject `now` for tests.
- Pipeline order: cached rows → `RawActivity[]` (rename fields) → `processActivities` → `ProcessedActivity[]` → `generateSuggestions`. The engine never sees DB rows.
- DB stores the **legacy** preferences shape (`sports`, `weeklyTargetMinutes`, `weeklyTargetSessions`, `intensityPref`, `restDays`, `longSessionDay`, `maxHr`, `notes`). The engine speaks a **different** shape (`goal`, `race_distance`, `race_date`, `days_available`, `long_run_day`, `bothering`, `volume_preference`, `notes`). Bridge: `adaptDbPrefs(row)` in `prefs-adapter.ts` — always call it before passing prefs to the engine. The form/API still read/write the legacy shape; do not change that without also doing a DB migration.
- Use `start_date_local` for "which day did the user train"; `start_date` (UTC) for ordering only.
- Drizzle: prefer `onConflictDoUpdate` over upsert logic; intensity stored as text with CHECK constraint, not pg enum.
- `expires_at` from Strava is **Unix seconds**, not ms — don't re-encode.

## Commands

```
pnpm dev          # dev server
pnpm build        # production build
pnpm typecheck    # tsc --noEmit
pnpm test         # vitest run
pnpm db:push      # apply Drizzle schema to DATABASE_URL
pnpm db:studio    # Drizzle studio
```

## Env vars

See `.env.example`. All validated by `src/env.ts` (zod) at import time.

## Strava brand compliance

- Use unmodified "Connect with Strava" button (`src/components/ConnectStravaButton.tsx` — SVG-rendered, swap for official PNG before public release).
- "Powered by Strava" badge in `src/components/PoweredByStrava.tsx`, present on every page that shows Strava data.
- Disconnect flow at `src/app/api/auth/disconnect/route.ts` calls `POST /oauth/deauthorize` then cascade-deletes the user.

## Rate limits

Strava: 100 / 15min + 1000 / day per app. Activity sync is gated to once per 15 min per user (`strava_rate_state.last_full_sync_at`). App-wide counters in `strava_app_rate_state` from response headers; if usage ≥95% of either window, requests preemptively throw `RateLimitedError`.

## Engine modes

`generateSuggestions` picks one of four paths up front:

- **`onboarding`** — `prefs.onboarded === false`, OR fewer than 5 lifetime activities, OR <25 km lifetime distance. Returns 3 canned suggestions (easy / easy or light-tempo / rest). No rules run.
- **`returning`** — no Run/TrailRun/VirtualRun in the last 14 days. Returns 3 canned conservative suggestions (very-easy / cross-train / rest). No rules run.
- **`race_day`** — `prefs.goal === "race"` and `race_date` is today. Returns a single shake-out/rest card.
- **`normal`** — runs `generateCandidates`, dedupes by `type` (keep lowest `priority`), pads up to 3 with fillers (`easy` → `long` → `cross-train` → `rest`), renumbers `priority` to `1, 2, 3`, strips the `source` tag, stamps a `suggestion_id`, and (in race-taper window) scales `duration_min` and `suggested_weekly_target_min` by `taperScalar`. Lower-priority candidates that didn't make the top 3 are returned as `alternatives` (up to 8).

The dashboard surfaces non-normal modes via a banner; tests assert on `mode`.

## Adding a new rule

1. Write a function in `src/lib/suggestions/rules.ts` that takes `RuleContext` and returns `RuleCandidate[]` (a `WorkoutSuggestion` plus a `source: string` tag for debugging and a `tier_break` from `tierBreakFor(type)`).
2. Call it from `generateCandidates(...)`. Recovery runs first and the rest gate themselves on `recoveryFired` — preserve that pattern if your rule is mutually-exclusive with recovery.
3. Set `priority` carefully — **lower wins** during dedupe; `tier_break` resolves cross-type ties at the same `priority`. Conventions: recovery=1, long-run=1, race-quality (tempo/intervals)=2, easy-default=3, cross/rest=4, variants=5–8, fillers=9–11. `tier_break` table is `TIER_BREAK_BY_TYPE` in `rules.ts`.
4. Taper-aware duration shrinking is centralized in `engine.ts → taperScalar / applyTaperScalar`. Do NOT multiply duration inside a rule — it will double-scale.
5. Add a vitest case in `tests/suggestions.test.ts`. Use `processActivities(rawAct(...))` to build inputs.
